/**
 * server/mcp-tools — the curated set of tools the local server exposes.
 *
 * SECURITY MODEL:
 *   - Every tool is EXPLICIT and query-scoped. There is no generic file
 *     read/write tool and no way to enumerate or dump the whole vault.
 *   - Writes go through `add_memory`, which ALWAYS proposes to the review inbox
 *     over the network — direct writes are never exposed to the server, even
 *     when the desktop `allowDirectWrites` setting is on.
 *   - Arguments are validated with the dependency-free validators before they
 *     reach the engine; retrieval limits are capped.
 *   - EVERY tool is rate-limited: a sliding per-minute window, or a cooldown
 *     for reindex. A tool with no limit is a hole in that defence, however
 *     cheap it looks, so new tools take one too.
 *
 * These handlers are pure with respect to Obsidian — they drive the same
 * EngramEngine the UI uses — so they are fully unit-testable with an in-memory
 * vault.
 */

import { EngramEngine } from "../engine";
import { EngramSettings } from "../settings/settings";
import { Logger } from "../utils/logger";
import { ValidationError } from "../utils/errors";
import { MS_PER_DAY, formatModifiedDate } from "../utils/format";
import { charsForTokens, estimateTokens } from "../utils/tokens";
import {
  requireObject,
  requireString,
  optionalString,
  optionalStringArray,
  optionalNumber,
  optionalBoolean,
} from "../utils/validation";
import { MemoryEntry, MEMORY_TYPES } from "../memory/memory-types";
import type { PendingEntry } from "../memory/pending-inbox";
import { dropNearDuplicates, diversifyByNote } from "../retrieval/ranking";
import { IndexedChunk } from "../indexing/index-manager";
import type { RetrievalQuery, RetrievalResult } from "../retrieval/retriever";

/** JSON-Schema-shaped tool description advertised via `tools/list`. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Shape of the `structuredContent` this tool returns, when it returns any.
   * Declared for exactly the tools that emit one — a schema without a payload
   * is a promise the server does not keep, and a client that validates would
   * be right to reject the call.
   */
  outputSchema?: Record<string, unknown>;
}

/**
 * What a tool hands back: prose for the model to read, and optionally the same
 * answer as data.
 *
 * The prose stays the primary channel and is never a serialization of the
 * structured form — a client that ignores `structuredContent` (every client
 * before this release, and the protocol's own default) must lose nothing. The
 * structured form exists so a caller that wants to cite a passage gets the
 * path and line span as fields rather than re-parsing them out of a label.
 */
export interface ToolResult {
  text: string;
  structured?: Record<string, unknown>;
}

/** Rate-limits repeated invocations of a keyed operation using an injected clock. */
export class RateLimiter {
  private readonly last = new Map<string, number>();
  private readonly windows = new Map<string, number[]>();
  constructor(private readonly clock: () => number) {}

  /** Throw a ValidationError if `key` was invoked within `cooldownMs`. */
  enforce(key: string, cooldownMs: number): void {
    const now = this.clock();
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < cooldownMs) {
      const wait = Math.ceil((cooldownMs - (now - prev)) / 1000);
      throw new ValidationError(`Rate limited: retry "${key}" in ${wait}s.`);
    }
    this.last.set(key, now);
  }

  /**
   * Sliding-window limit: throw if `key` has already been called `maxCalls`
   * times within the last `windowMs`. Bounds sustained flooding of a tool
   * (e.g. add_memory filling the inbox, or CPU-heavy search) without blocking
   * normal bursts.
   */
  enforceWindow(key: string, maxCalls: number, windowMs: number): void {
    const now = this.clock();
    const cutoff = now - windowMs;
    const recent = (this.windows.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= maxCalls) {
      throw new ValidationError(`Rate limited: too many "${key}" requests; slow down.`);
    }
    recent.push(now);
    this.windows.set(key, recent);
  }
}

export interface ToolContext {
  engine: EngramEngine;
  settings: EngramSettings;
  logger: Logger;
  clock: () => number;
  rateLimiter: RateLimiter;
}

export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<string | ToolResult>;

interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// --- caps / limits -----------------------------------------------------------

const SEARCH_MAX_LIMIT = 25;
const SEARCH_DEFAULT_LIMIT = 8;
const SESSIONS_MAX_LIMIT = 20;
const REINDEX_COOLDOWN_MS = 15_000;
const RATE_WINDOW_MS = 60_000;
const SEARCH_MAX_PER_MINUTE = 120;
const ADD_MEMORY_MAX_PER_MINUTE = 60;
const SUMMARIZE_MAX_PER_MINUTE = 30;
const SUMMARY_DEFAULT_SENTENCES = 5;
const SUMMARY_MAX_SENTENCES = 20;
// Sentence count alone doesn't bound what a summary costs: units are split on
// lines first, so a line with no sentence terminator (pasted JSON, base64, a
// wide table row) stays ONE unit however long it is. Unbounded, the tool whose
// whole purpose is cheap context returned more than a full note read (measured:
// 20k chars from 12 such lines). 20 ordinary sentences land well under this.
const SUMMARY_MAX_CHARS = 4_000;
// `list_pending_memory` reads one file and formats it, so it is cheap — but it
// is also the tool an agent is most tempted to poll after every proposal. It is
// given the same per-tool ceiling as the bulk context reads — `enforceWindow`
// keys its window by tool name, so this is its own 60/min, not a budget shared
// with them. Reading it costs a full read and parse of the inbox (`readInbox`
// is uncached, unlike the dedup cache `proposeToInbox` keeps), so the cost
// grows with an unreviewed backlog rather than with vault size. It takes the
// shared `maxChars` schema and `contextMaxChars` too: advertising that schema
// while validating a narrower range would reject the very value the schema
// tells an agent to send.
const PENDING_MAX_LIMIT = 50;
const PENDING_DEFAULT_LIMIT = 20;
// `get_recent_changes` reads an in-memory map and formats it — no I/O, no
// scoring. The limit exists to bound OUTPUT, not work: a vault where thousands
// of notes changed in the window would otherwise return a wall of paths that
// costs the agent more context than the answer is worth.
const CHANGES_MAX_LIMIT = 200;
const CHANGES_DEFAULT_LIMIT = 50;
const CHANGES_DEFAULT_DAYS = 7;
const CHANGES_MAX_DAYS = 365;
// How many project names any one `resolve_project` reply lists. Shared by the
// near-match and no-match branches so one reply cannot use two rules.
const PROJECT_LIST_MAX = 25;
// Batched search. The cap is low on purpose: in vector or hybrid mode EVERY
// query costs its own embedding round trip, so this multiplies network work
// even though it is one MCP call. Five covers the real use — a handful of
// related questions asked at once — without turning one call into a burst.
const BATCH_MAX_QUERIES = 5;
const NOTE_CONTEXT_MAX_PER_MINUTE = 60;
const NOTE_CONTEXT_DEFAULT_MAX_CHARS = 12_000;
const NOTE_CONTEXT_MAX_CHARS = 50_000;
// Bulk context reads (project/global/sessions): the session-priming tools.
// They concatenate whole memory files, so as a project's memory grows they
// become the biggest token sink in the agent loop — cap them like
// get_note_context instead of returning unbounded output.
const CONTEXT_MAX_PER_MINUTE = 60;
const CONTEXT_DEFAULT_MAX_CHARS = 12_000;
const CONTEXT_MAX_CHARS = 50_000;
// Budget per direction for find_related_notes. Hub/MOC notes — the ones an
// agent is most likely to navigate from — can link hundreds of notes, and this
// was the only read surface with no bound at all.
//
// Budgeted in CHARS rather than link count because per-link cost varies ~3.8x
// with path depth (measured: 15 chars for `Notes/n12.md`, 57 for
// `Claude Code/Projects/atlas/Sessions/2026-07-30-0915.md`), so one count cap
// buys wildly different amounts of context — 50 links is 759 chars of shallow
// paths but 2,859 of the deep ones this plugin's own memory notes use. At this
// budget a list stays cheaper than a realistic session-history page (~1,100
// chars) while still showing ~26 deep, ~50 typical, or ~100 shallow links, so
// ordinary notes list in full and only hubs are clipped.
const RELATED_MAX_CHARS = 1_500;
// Budget for the project list. It reads as a handful of short names, which is
// how it ended up the only read tool returning its whole result — but the names
// are not ours: `project` is accepted up to 200 chars where an agent supplies
// one, and a folder created by hand can be longer still. Measured at that
// length, 1 000 projects is 197 KB and 5 000 is 985 KB — roughly 49k and 246k
// tokens of the agent's context, spent by the tool whose job is to save it.
// 4 000 chars lists ~190 names of ordinary length in full, so only a vault with
// hundreds of projects is clipped, and it is told exactly how many are missing.
const LIST_PROJECTS_MAX_CHARS = 4_000;

/**
 * Full heading breadcrumb for a chunk. `headingPath` holds ANCESTORS only (the
 * chunker excludes the section's own heading), so joining it alone drops the
 * most specific level — "Doc" instead of "Doc › Alpha".
 */
function chunkHeadingLabel(c: IndexedChunk): string {
  const parts = [...c.headingPath, c.heading].filter(Boolean);
  return parts.length ? parts.join(" › ") : "(top)";
}

/**
 * De-duplicate a same-section follow-on window's text against the previous
 * window: strip the repeated markdown heading line and the chunker's ~150-char
 * window-carry overlap. The carry is an INDEXING artifact — it is excluded
 * from the chunk's line span by the chunker — so removing it makes the text
 * agree with the advertised line ranges. The strip rule is lossless by
 * construction: a prefix is removed only when the previous window's text ends
 * with it (verbatim), i.e. the reader has those characters immediately above.
 */
function dedupWindowText(prevText: string, c: IndexedChunk): { text: string; carried: boolean } {
  let rest = c.text;
  const header = c.heading ? `${"#".repeat(c.headingPath.length + 1)} ${c.heading}` : "";
  if (header && rest.startsWith(header)) rest = rest.slice(header.length).trimStart();
  const MAX_CARRY = 200; // overlapChars (150) + separators, with headroom
  const probe = rest.slice(0, MAX_CARRY);
  for (let len = probe.length; len >= 12; len--) {
    const candidate = probe.slice(0, len).trimEnd();
    // ≥12-char anchor so a coincidental short suffix/prefix match can't strip.
    if (candidate.length >= 12 && prevText.endsWith(candidate)) {
      return { text: rest.slice(len).trimStart(), carried: true };
    }
  }
  return { text: rest, carried: false };
}

function sameSection(a: IndexedChunk, b: IndexedChunk): boolean {
  return a.heading === b.heading && a.headingPath.join("\u0000") === b.headingPath.join("\u0000");
}

/**
 * The `limit` and scope filters shared by `search_vault_memory` and
 * `search_batch`.
 *
 * Extracted because the duplicate copy was INPUT VALIDATION, and mutation
 * testing showed the second one was entirely unverified — dropping the filters
 * from the batch search left every test green. Duplicating untested validation
 * is how a folder, tag, or project restriction silently stops applying on one
 * of two paths.
 */
function parseSearchScope(
  obj: Record<string, unknown>,
  ctx: ToolContext,
): { limit: number; filters: RetrievalQuery["filters"] } {
  const limit = Math.trunc(
    optionalNumber(obj, "limit", SEARCH_DEFAULT_LIMIT, { min: 1, max: SEARCH_MAX_LIMIT }),
  );
  const sinceDays = optionalNumber(obj, "sinceDays", 0, { min: 0, max: 36_500 });
  return {
    limit,
    filters: {
      folder: optionalString(obj, "folder", "", 1000) || undefined,
      tag: optionalString(obj, "tag", "", 200) || undefined,
      project: optionalString(obj, "project", "", 200) || undefined,
      sinceMtime: sinceDays > 0 ? ctx.clock() - sinceDays * MS_PER_DAY : undefined,
    },
  };
}

/**
 * Apply the opt-in context savings to a ranked page.
 *
 * Each saving hides something the user may have wanted — a second copy of a
 * memory, a long note's later hits — so neither is applied unless asked for.
 * With both off this is the ranked results cut to `limit`.
 */
function applyContextSavings<T extends { chunk: IndexedChunk }>(
  results: T[],
  limit: number,
  settings: EngramSettings,
): T[] {
  const savings = settings.contextSavings;
  const collapsed = savings.collapseNearDuplicates ? dropNearDuplicates(results) : results;
  return savings.capPerNoteShare ? diversifyByNote(collapsed, limit) : collapsed.slice(0, limit);
}

/**
 * The one-line label above a search hit: path, heading, line range, modified
 * date, and a pending-review marker.
 *
 * Shared by `search_vault_memory` and `search_batch` so the two cannot drift —
 * an agent that learns to read one is reading the other. The format is
 * deliberately lean: enough to locate or fetch the passage, and no score float,
 * because rank order already conveys that and every token should aid recall.
 *
 * The modified date is what lets an agent judge staleness when two memories
 * conflict — a deliberate alternative to recency RANKING, which would change
 * scoring semantics. Day granularity, ~11 characters per result.
 *
 * Inbox hits are marked because they are agent PROPOSALS awaiting human review,
 * not accepted memory: without the marker an agent's own unreviewed write comes
 * back through search looking like the user's settled knowledge.
 */
function searchResultLabel(r: RetrievalResult, pendingPath: string): string {
  const heading = chunkHeadingLabel(r.chunk);
  const start = r.chunk.startLine + 1;
  const end = Math.max(start, r.chunk.endLine + 1);
  const lines = start === end ? `L${start}` : `L${start}–${end}`;
  const modified = formatModifiedDate(r.chunk.mtime);
  const pending =
    r.chunk.notePath === pendingPath ? " [PENDING REVIEW — proposed, not yet accepted]" : "";
  return `${r.chunk.notePath} › ${heading} (${lines}, ${modified})${pending}`;
}

/** Clip `text` to `maxChars`, flagging the cut with a follow-up hint. */
function clipContext(text: string, maxChars: number, hint: string): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n…(truncated at ${maxChars} chars; ${hint})`;
}

/**
 * Assemble path-labeled blocks under a `maxChars` budget, clipping at BLOCK
 * boundaries and naming what was left out — a silently missing tail file is a
 * recall hole (the agent can't follow up on content it never learned exists),
 * and the paths give it the exact `get_note_context` reads to make next.
 */
function assembleLabeledBlocks(
  blocks: Array<{ path: string; block: string }>,
  maxChars: number,
): string {
  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const { path, block } of blocks) {
    const sep = kept.length > 0 ? 7 : 0; // "\n\n---\n\n"
    if (omitted.length > 0 || used + sep + block.length > maxChars) {
      // A single oversized first block is still clipped (hard ceiling).
      if (kept.length === 0) {
        kept.push(block.slice(0, maxChars));
        omitted.push(`${path} (truncated)`);
      } else {
        omitted.push(path);
      }
      continue;
    }
    kept.push(block);
    used += sep + block.length;
  }
  const body = kept.join("\n\n---\n\n");
  return omitted.length === 0
    ? body
    : `${body}\n\n…(clipped at ${maxChars} chars; omitted: ${omitted.join(", ")} — read with get_note_context)`;
}

/**
 * How many of `blocks` fit in `maxChars` once joined by a `sepLen` separator.
 *
 * Always at least 1: a page with nothing on it helps nobody, and the caller
 * still applies `clipContext` as a hard ceiling for a single oversized item.
 *
 * This exists so a listing can decide ONCE what it is returning, and build both
 * its prose and its structured payload from that decision. Clipping the prose
 * after the fact — which is what a raw `clipContext` over a joined body does —
 * left the two halves disagreeing: at `maxChars: 200` the text showed one entry
 * while the structured array still listed five, and a caller reading fields
 * instead of prose received content its own `maxChars` was meant to bound.
 */
function blocksThatFit(blocks: string[], maxChars: number, sepLen: number): number {
  let used = 0;
  for (let i = 0; i < blocks.length; i++) {
    const sep = i > 0 ? sepLen : 0;
    if (i > 0 && used + sep + blocks[i].length > maxChars) return i;
    used += sep + blocks[i].length;
  }
  return blocks.length;
}

/**
 * Cut a page to `maxChars` at ITEM boundaries, returning the items and their
 * rendered blocks as one slice.
 *
 * One routine for every place that does this, because the two halves of a
 * result must be built from the same decision — the bug this replaced rendered
 * everything and sliced only the prose, leaving the structured payload
 * describing entries the text had thrown away.
 */
function sliceToFit<T>(
  maxChars: number,
  items: T[],
  blocks: string[],
  sepLen: number,
): { items: T[]; blocks: string[] } {
  const fits = blocksThatFit(blocks, maxChars, sepLen);
  return { items: items.slice(0, fits), blocks: blocks.slice(0, fits) };
}

/**
 * The character budget for a bulk read: `maxChars`, narrowed by `tokenBudget`
 * when the caller gave one.
 *
 * The smaller of the two wins. They are two spellings of one request, and a
 * caller that sends both means the tighter of them — resolving it any other way
 * would let a generous `maxChars` quietly undo an explicit token budget. Only
 * `tokenBudget` may take the result below `maxChars`'s own floor, because there
 * it is what the caller actually asked for rather than a default they inherited.
 */
function contextMaxChars(obj: Record<string, unknown>): number {
  const maxChars = Math.trunc(
    optionalNumber(obj, "maxChars", CONTEXT_DEFAULT_MAX_CHARS, {
      min: 1000,
      max: CONTEXT_MAX_CHARS,
    }),
  );
  const budget = tokenBudgetChars(obj);
  return budget === null ? maxChars : Math.min(maxChars, budget);
}

/** `tokenBudget` as a character count, or null when the caller gave none. */
function tokenBudgetChars(obj: Record<string, unknown>): number | null {
  if (obj.tokenBudget === undefined) return null;
  const tokens = Math.trunc(
    optionalNumber(obj, "tokenBudget", MAX_TOKEN_BUDGET, {
      min: MIN_TOKEN_BUDGET,
      max: MAX_TOKEN_BUDGET,
    }),
  );
  return charsForTokens(tokens);
}

/**
 * Smallest budget worth honouring. Below this a page has room for a preamble
 * and little else, and a caller is better served by a narrower query than by a
 * page too small to answer anything.
 */
const MIN_TOKEN_BUDGET = 256;
const MAX_TOKEN_BUDGET = 16_000;

const TOKEN_BUDGET_SCHEMA = {
  type: "number",
  description:
    `Cap this call's output at roughly this many tokens (${MIN_TOKEN_BUDGET}–${MAX_TOKEN_BUDGET}). ` +
    `Estimated, not exact, and deliberately conservative — you will get a little ` +
    `less than you asked for rather than more. Combined with maxChars, the smaller wins.`,
} as const;

const MAX_CHARS_SCHEMA = {
  type: "number",
  description:
    `Max characters returned (1000–${CONTEXT_MAX_CHARS}, default ` +
    `${CONTEXT_DEFAULT_MAX_CHARS}); output is truncated past this.`,
} as const;

// --- structured output -------------------------------------------------------

/**
 * One search hit, as data.
 *
 * The fields are exactly what the prose label spells out — path, heading, line
 * span, date — so a caller that wants to cite a passage reads them instead of
 * parsing a `path › heading (L4–9, 2026-07-03)` string that was written for a
 * human. `score` is present here and deliberately absent from the prose, where
 * rank order already conveys it and a float would just cost tokens.
 */
function searchResultRecord(
  r: RetrievalResult,
  pendingPath: string,
): Record<string, unknown> {
  return {
    path: r.chunk.notePath,
    heading: chunkHeadingLabel(r.chunk),
    startLine: r.chunk.startLine + 1,
    endLine: Math.max(r.chunk.startLine + 1, r.chunk.endLine + 1),
    modified: formatModifiedDate(r.chunk.mtime),
    score: r.score,
    snippet: r.snippet,
    // Same warning the label carries: a hit in the review inbox is a proposal
    // awaiting a human, not accepted memory. A structured consumer that only
    // read the fields would otherwise lose the one caveat that matters most.
    pendingReview: r.chunk.notePath === pendingPath,
  };
}

const SEARCH_RESULT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string" },
    heading: { type: "string" },
    startLine: { type: "number" },
    endLine: { type: "number" },
    modified: { type: "string" },
    score: { type: "number" },
    snippet: { type: "string" },
    pendingReview: { type: "boolean" },
  },
  required: ["path", "heading", "startLine", "endLine", "pendingReview"],
} as const;

const SEARCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: { results: { type: "array", items: SEARCH_RESULT_ITEM_SCHEMA } },
  required: ["results"],
} as const;

/**
 * One inbox entry, as data. Shared by the pending and rejected listings.
 *
 * `content` and `reason` are bounded by the same `maxChars` the prose is. A
 * proposal may be 50,000 characters and a page may hold 50 of them, so leaving
 * the payload unbounded made `maxChars` bound only the channel a caller
 * happened not to be reading — measured at 491 KB returned against a
 * 1,000-character request.
 */
function inboxEntryRecord(e: PendingEntry, maxChars: number): Record<string, unknown> {
  const clip = (s: string) => (s.length <= maxChars ? s : `${s.slice(0, maxChars)}…`);
  return {
    type: e.type,
    project: e.project ?? null,
    proposedAt: e.timestampLabel,
    content: clip(e.content),
    reason: e.reason ? clip(e.reason) : null,
    supersedes: e.supersedes ?? null,
    similarTo: e.similarTo ?? null,
  };
}

const INBOX_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    total: { type: "number" },
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          project: { type: ["string", "null"] },
          proposedAt: { type: "string" },
          content: { type: "string" },
          reason: { type: ["string", "null"] },
          supersedes: { type: ["string", "null"] },
          similarTo: { type: ["string", "null"] },
        },
        required: ["type", "proposedAt", "content"],
      },
    },
  },
  required: ["total", "entries"],
} as const;

// --- tool implementations ----------------------------------------------------

const searchTool: Tool = {
  definition: {
    name: "search_vault_memory",
    description:
      "Search the vault's memory index (BM25 lexical by default, or vector/hybrid " +
      "when an embedding provider is configured). Returns query-scoped chunks — note " +
      "path, heading, line range, modified date, and a snippet. Near-duplicate " +
      "collapsing and per-note capping are opt-in and off by default, so two chunks " +
      "of the same passage can both appear. Never returns whole notes or the full " +
      "vault.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        limit: {
          type: "number",
          description: `Max results (1–${SEARCH_MAX_LIMIT}, default ${SEARCH_DEFAULT_LIMIT}).`,
        },
        folder: { type: "string", description: "Restrict to notes under this vault-relative folder." },
        tag: { type: "string", description: "Restrict to notes carrying this tag (no leading #)." },
        project: { type: "string", description: "Restrict to a project under the projects root." },
        sinceDays: { type: "number", description: "Only notes modified within this many days." },
        tokenBudget: TOKEN_BUDGET_SCHEMA,
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: SEARCH_OUTPUT_SCHEMA,
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("search_vault_memory", SEARCH_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const obj = requireObject(args, "arguments");
    const query = requireString(obj, "query", { maxLength: 2000 });
    const { limit, filters } = parseSearchScope(obj, ctx);
    // Resolved with the other arguments, not where it is first used: a bad
    // budget must be refused whatever the results turn out to be, or it is
    // accepted on an empty vault and rejected on a full one.
    const budget = tokenBudgetChars(obj);

    // Fetch a deeper candidate pool than the page so the near-duplicate drop
    // below can backfill with distinct results instead of leaving the page
    // short of `limit`.
    const results = await ctx.engine.search({ query, limit: limit * 2, filters });

    if (results.length === 0) {
      return { text: `No results for "${query}".`, structured: { results: [] } };
    }
    // Drop near-duplicate hits so the agent isn't fed (and charged tokens for)
    // the same memory twice — e.g. a decision copied into a session note. Then
    // re-apply the per-note cap at the page size (the deep fetch diversified at
    // a looser cap scaled to the candidate count — same binding-pass pattern as
    // HybridRetriever) and cut the pool back down to `limit`. The format is
    // deliberately lean: note path, heading, and line range so the agent can
    // locate or fetch the passage, then the snippet. No score float (rank order
    // already conveys it) — every token returned should aid recall.
    // Each context saving is opt-in on its own: both hide something the user
    // may have wanted (a second copy of a memory; a long note's later hits), so
    // neither is applied unless asked for. With both off the page is simply the
    // ranked results cut to `limit`.
    const distinct = applyContextSavings(results, limit, ctx.settings);
    // Hits from the review inbox are agent PROPOSALS awaiting human review, not
    // accepted memory — mark them so an agent's own unreviewed write can't come
    // back through search looking like the user's settled knowledge.
    const pendingPath = ctx.engine.getPaths().pendingMemoryFile;
    const blocks = distinct.map(
      (r, i) => `${i + 1}. ${searchResultLabel(r, pendingPath)}\n${r.snippet}`,
    );
    // Trimmed at RESULT boundaries, and the same slice feeds both halves — a
    // budget that cut a snippet in half would spend tokens on a passage the
    // agent cannot use, which is the opposite of what it asked for.
    // "\n\n" between blocks. Untouched when no budget was given, which is the
    // common case and must cost nothing.
    const page = budget === null ? { items: distinct, blocks } : sliceToFit(budget, distinct, blocks, 2);
    const text = `${page.items.length} result(s):\n\n${page.blocks.join("\n\n")}`;
    return {
      text,
      structured: {
        results: page.items.map((r) => searchResultRecord(r, pendingPath)),
        estimatedTokens: estimateTokens(text),
      },
    };
  },
};

const addMemoryTool: Tool = {
  definition: {
    name: "add_memory",
    description:
      "Propose a memory entry. Over the network this ALWAYS appends to the review " +
      "inbox (Memory/Inbox/pending-memory.md) — it never writes directly to a " +
      "memory file and never overwrites anything. The user reviews and applies it " +
      "in Obsidian.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory content (Markdown)." },
        type: { type: "string", enum: MEMORY_TYPES, description: "Kind of memory (default: note)." },
        project: { type: "string", description: "Associated project name, if any." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
        source: { type: "string", description: "Where this came from (default: MCP)." },
        relatedPaths: { type: "array", items: { type: "string" }, description: "Related note paths." },
        supersedes: {
          type: "string",
          description:
            "Optional \"<path>#<heading>\" of a memory this one REPLACES, taken from a search " +
            "result's label. Must name a section of a file under the memory root. On approval " +
            "the named memory stops being returned by search and context reads; its text is " +
            "left in place. Use it when a fact has changed, not when you are adding detail.",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("add_memory", ADD_MEMORY_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const obj = requireObject(args, "arguments");
    const content = requireString(obj, "content", { maxLength: 50_000 });
    const rawType = optionalString(obj, "type", "note", 40);
    const type = (MEMORY_TYPES as readonly string[]).includes(rawType)
      ? (rawType as MemoryEntry["type"])
      : "note";
    const project = optionalString(obj, "project", "", 200) || undefined;
    const source = optionalString(obj, "source", "MCP", 200) || "MCP";
    // Sized to what the field IS: a tag is a word, a related path is a vault
    // path. Without a per-item bound the content cap above is decorative —
    // the same 1 MB body fits in `relatedPaths` instead.
    const tags = optionalStringArray(obj, "tags", 64, 128);
    const relatedPaths = optionalStringArray(obj, "relatedPaths", 128, 512);
    // A vault path plus a heading; the engine validates it against the memory
    // root before the proposal is written.
    const supersedes = optionalString(obj, "supersedes", "", 1_000) || undefined;

    // Network path is inbox-only by construction: no `direct` option is passed.
    const { path, duplicate, rejection, similarTo } = await ctx.engine.addMemory({
      type,
      content,
      project,
      source,
      originTool: "mcp:add_memory",
      tags,
      relatedPaths,
      supersedes,
    });
    // A rejection is reported, never hidden: the whole reason the ledger exists
    // is that an agent could not tell a rejected proposal from an accepted one,
    // so a bare "not added" here would leave the loop exactly as open as before.
    if (rejection) {
      const why = rejection.reason ? ` Reason given: ${rejection.reason}` : "";
      return (
        `A reviewer rejected this exact memory (proposed ${rejection.timestampLabel}); ` +
        `not proposed again.${why} Do not re-propose it verbatim — propose it only if ` +
        `you have genuinely new detail, which counts as a different memory.`
      );
    }
    if (duplicate) return `An identical memory is already pending review in ${path}; not added again.`;
    if (supersedes) {
      return (
        `Proposed memory appended to ${path} for review. It claims to replace ${supersedes}; ` +
        `that memory is retired only if a reviewer applies this entry.`
      );
    }
    // Reported, never acted on. Deciding that two memories disagree is a
    // judgement this cannot make offline, so it names the candidate and the one
    // action that resolves it.
    return similarTo
      ? `Proposed memory appended to ${path} for review. An existing memory covers similar ` +
          `ground: ${similarTo}. If this REPLACES it, propose again with ` +
          `supersedes: "${similarTo}" so the old one is retired instead of contradicting this ` +
          `one. If it only adds detail, leave it as proposed.`
      : `Proposed memory appended to ${path} for review.`;
  },
};

const getProjectContextTool: Tool = {
  definition: {
    name: "get_project_context",
    description:
      "Return the concatenated project memory (overview → architecture → " +
      "decisions → tasks → open questions) for a named project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name." },
        maxChars: MAX_CHARS_SCHEMA,
        tokenBudget: TOKEN_BUDGET_SCHEMA,
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("get_project_context", CONTEXT_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const obj = requireObject(args, "arguments");
    const project = requireString(obj, "project", { maxLength: 200 });
    const maxChars = contextMaxChars(obj);
    const parts = await ctx.engine.getProjectContext(project);
    if (parts.length === 0) return `No project memory found for "${project}".`;
    return assembleLabeledBlocks(
      parts.map((p) => ({ path: p.path, block: `${p.path}:\n${p.content}` })),
      maxChars,
    );
  },
};

const getGlobalContextTool: Tool = {
  definition: {
    name: "get_global_context",
    description: "Return the concatenated global memory (profile + preferences + conventions).",
    inputSchema: {
      type: "object",
      properties: { maxChars: MAX_CHARS_SCHEMA, tokenBudget: TOKEN_BUDGET_SCHEMA },
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("get_global_context", CONTEXT_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const obj = requireObject(args ?? {}, "arguments");
    const maxChars = contextMaxChars(obj);
    const parts = await ctx.engine.getGlobalContext();
    if (parts.length === 0) return "No global memory recorded yet.";
    return assembleLabeledBlocks(
      parts.map((p) => ({ path: p.path, block: `${p.path}:\n${p.content}` })),
      maxChars,
    );
  },
};

const listProjectsTool: Tool = {
  definition: {
    name: "list_projects",
    description:
      `List the project names under the projects root. Clipped at ` +
      `${LIST_PROJECTS_MAX_CHARS} characters, saying how many are not shown.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        projects: { type: "array", items: { type: "string" } },
        total: { type: "number" },
      },
      required: ["projects"],
    },
  },
  async handler(_args, ctx) {
    // Cheap-looking, but it lists every Markdown file in the vault and scans
    // the paths, so its cost grows with the vault (measured 0.5 ms at 1k notes,
    // 3.5 ms at 20k) and it is spent on the app's main thread.
    ctx.rateLimiter.enforceWindow("list_projects", CONTEXT_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const projects = await ctx.engine.listProjects();
    if (projects.length === 0) {
      return { text: "No projects yet.", structured: { projects: [], total: 0 } };
    }
    const kept: string[] = [];
    let used = 0;
    for (const name of projects) {
      const cost = kept.length === 0 ? name.length : name.length + 1; // + "\n"
      if (used + cost > LIST_PROJECTS_MAX_CHARS) break;
      kept.push(name);
      used += cost;
    }
    const omitted = projects.length - kept.length;
    return {
      text:
        omitted === 0
          ? kept.join("\n")
          : `${kept.join("\n")}\n\n…(clipped at ${LIST_PROJECTS_MAX_CHARS} chars; ${omitted} more not shown)`,
      // The names actually shown, so the two halves cannot disagree about what
      // was clipped; `total` carries the rest of the truth.
      structured: { projects: kept, total: projects.length },
    };
  },
};

const getRecentSessionsTool: Tool = {
  definition: {
    name: "get_recent_sessions",
    description: "Return the most recent session notes for a project (most recent first).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name." },
        limit: { type: "number", description: `Max sessions (1–${SESSIONS_MAX_LIMIT}, default 5).` },
        maxChars: MAX_CHARS_SCHEMA,
        tokenBudget: TOKEN_BUDGET_SCHEMA,
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("get_recent_sessions", CONTEXT_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const obj = requireObject(args, "arguments");
    const project = requireString(obj, "project", { maxLength: 200 });
    const limit = Math.trunc(optionalNumber(obj, "limit", 5, { min: 1, max: SESSIONS_MAX_LIMIT }));
    const maxChars = contextMaxChars(obj);
    const sessions = await ctx.engine.getRecentSessions(project, limit);
    if (sessions.length === 0) return `No sessions found for "${project}".`;
    return assembleLabeledBlocks(
      sessions.map((s) => ({ path: s.path, block: `## ${s.path}\n\n${s.content.trim()}` })),
      maxChars,
    );
  },
};

const reindexTool: Tool = {
  definition: {
    name: "reindex_vault",
    description:
      "Rebuild the memory/RAG index from the current vault. Rate-limited; use " +
      "sparingly. Returns the resulting note and chunk counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  async handler(_args, ctx) {
    if (!ctx.settings.indexingEnabled) {
      throw new ValidationError("Indexing is disabled in settings.");
    }
    ctx.rateLimiter.enforce("reindex_vault", REINDEX_COOLDOWN_MS);
    const { noteCount, chunkCount } = await ctx.engine.reindex();
    return `Reindexed: ${noteCount} note(s), ${chunkCount} chunk(s).`;
  },
};

const summarizeNoteTool: Tool = {
  definition: {
    name: "summarize_note",
    description:
      "Extractive summary of a single INDEXED note: returns a few of the note's " +
      "OWN sentences (never generated/invented text), chosen by relevance. Only " +
      "notes present in the index can be summarized — an excluded or unindexed " +
      `note is refused, so this is not a general file-read. Output is capped at ` +
      `${SUMMARY_MAX_CHARS} characters.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path of the note to summarize." },
        maxSentences: {
          type: "number",
          description: `Max sentences (1–${SUMMARY_MAX_SENTENCES}, default ${SUMMARY_DEFAULT_SENTENCES}).`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("summarize_note", SUMMARIZE_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const obj = requireObject(args, "arguments");
    const path = requireString(obj, "path", { maxLength: 1000 });
    const maxSentences = Math.trunc(
      optionalNumber(obj, "maxSentences", SUMMARY_DEFAULT_SENTENCES, {
        min: 1,
        max: SUMMARY_MAX_SENTENCES,
      }),
    );
    const summary = await ctx.engine.summarizeNote(path, { maxSentences });
    if (summary.sentences.length === 0) {
      return `No summarizable content found in "${summary.notePath}".`;
    }
    const flags = summary.truncated ? " · note truncated for summarization" : "";
    const header =
      `Extractive summary of ${summary.notePath} ` +
      `(${summary.sentences.length} of ${summary.totalUnits} sentences · ${summary.method})${flags}:`;
    const body = clipContext(
      summary.sentences.map((s) => `• ${s}`).join("\n"),
      SUMMARY_MAX_CHARS,
      "this note's lines are long; read a range with get_note_context",
    );
    return `${header}\n\n${body}`;
  },
};

const getNoteContextTool: Tool = {
  definition: {
    name: "get_note_context",
    description:
      "Return the full INDEXED text of a single note, passage by passage, each " +
      "with its heading and line range — the natural follow-up to a search hit, " +
      "which only returns a short snippet. Pass startLine/endLine (e.g. from a " +
      "search hit's line range) to read just the passages overlapping that span — " +
      "essential for hits deep in a long note. Pass outline=true for a cheap " +
      "headings-only map of the note (one line per passage, no body) before " +
      "committing to a full read. Only notes present in the index are returned; " +
      "an excluded or unindexed note is refused, so this is not a general " +
      "file-read.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path of the note to read." },
        maxChars: {
          type: "number",
          description:
            `Max characters returned (1000–${NOTE_CONTEXT_MAX_CHARS}, default ` +
            `${NOTE_CONTEXT_DEFAULT_MAX_CHARS}); the note is truncated past this.`,
        },
        tokenBudget: TOKEN_BUDGET_SCHEMA,
        startLine: {
          type: "number",
          description: "Only passages ending at/after this 1-based line (e.g. a search hit's start).",
        },
        endLine: {
          type: "number",
          description: "Only passages starting at/before this 1-based line.",
        },
        outline: {
          type: "boolean",
          description:
            "Return only the heading outline (line range + heading per passage, no body) — " +
            "a cheap map before a full read.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("get_note_context", NOTE_CONTEXT_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const obj = requireObject(args, "arguments");
    const path = requireString(obj, "path", { maxLength: 1000 });
    // This tool's own ceiling is the highest on the surface (50,000), and a
    // full-note read after a search hit is exactly when an agent is nearest its
    // context limit — so it takes a budget like the other bulk reads, narrowing
    // its own `maxChars` rather than adding a second truncation rule.
    const budget = tokenBudgetChars(obj);
    const requested = Math.trunc(
      optionalNumber(obj, "maxChars", NOTE_CONTEXT_DEFAULT_MAX_CHARS, {
        min: 1000,
        max: NOTE_CONTEXT_MAX_CHARS,
      }),
    );
    const maxChars = budget === null ? requested : Math.min(requested, budget);

    // 1-based, matching the line ranges shown by search_vault_memory; 0 = unset
    // (the fallback bypasses min-validation by design).
    const startLine = Math.trunc(optionalNumber(obj, "startLine", 0, { min: 1, max: 100_000_000 }));
    const endLine = Math.trunc(optionalNumber(obj, "endLine", 0, { min: 1, max: 100_000_000 }));
    if (startLine > 0 && endLine > 0 && endLine < startLine) {
      throw new ValidationError(`Field "endLine" must be >= "startLine"`);
    }
    const outline = optionalBoolean(obj, "outline");

    // Indexed-only gate (same as summarize_note): an excluded/unindexed note has
    // no chunks and is refused, so this can never read a note the exclusion
    // filters were meant to keep out.
    // Readable, not raw: a retired section must not come back through this
    // door after search and the context reads stopped returning it.
    const allChunks = await ctx.engine.getReadableNoteChunks(path);
    if (allChunks.length === 0) {
      throw new ValidationError(
        `Note "${path}" is not indexed (it may be excluded or outside the vault). ` +
          `Only indexed notes can be read.`,
      );
    }

    // Range filter: keep passages overlapping [startLine, endLine]. Runs AFTER
    // the indexed-only gate so an excluded note is refused, never "empty range".
    // Chunk spans are 0-based; the tool's line numbers are 1-based.
    const chunks =
      startLine > 0 || endLine > 0
        ? allChunks.filter(
            (c) =>
              (endLine === 0 || c.startLine + 1 <= endLine) &&
              (startLine === 0 || c.endLine + 1 >= startLine),
          )
        : allChunks;
    if (chunks.length === 0) {
      const first = allChunks[0].startLine + 1;
      const last = allChunks[allChunks.length - 1].endLine + 1;
      return (
        `No indexed passages of "${path}" overlap lines ` +
        `${startLine > 0 ? startLine : 1}–${endLine > 0 ? endLine : "end"}; ` +
        `the note's indexed passages span lines ${first}–${last}.`
      );
    }

    const rangeLabel = (startLine0: number, endLine0: number) => {
      const start = startLine0 + 1;
      const end = Math.max(start, endLine0 + 1);
      return start === end ? `Line ${start}` : `Lines ${start}–${end}`;
    };
    const headingLabel = chunkHeadingLabel;
    const noteSpan = `L${allChunks[0].startLine + 1}–${allChunks[allChunks.length - 1].endLine + 1}`;
    const scope =
      chunks.length === allChunks.length
        ? `${chunks.length} indexed passage(s)`
        : `${chunks.length} of ${allChunks.length} indexed passage(s) overlapping the requested lines`;

    // Group consecutive windows of ONE section: they repeat the section's
    // heading and each carries ~150 chars of the previous window's text, so
    // rendering them individually resends both per window. A window joins the
    // previous group only when its carry verifiably matches (dedupWindowText),
    // which distinguishes true continuation windows from ADJACENT SIBLING
    // sections that merely share a heading (e.g. repeated "## Entry" logs) —
    // those have no carry and must stay separate blocks.
    interface WindowGroup {
      chunks: IndexedChunk[];
      pieces: string[]; // per-window text, carry/heading de-duplicated
    }
    // Merging windows and stripping their carry is its own opt-in: with it off
    // every window renders as its own block, exactly as it sits in the index,
    // overlap included.
    const mergeWindows = ctx.settings.contextSavings.mergeOverlappingPassages;
    const groups: WindowGroup[] = [];
    for (const c of chunks) {
      const g = groups[groups.length - 1];
      if (mergeWindows && g && sameSection(g.chunks[g.chunks.length - 1], c)) {
        const deduped = dedupWindowText(g.chunks[g.chunks.length - 1].text, c);
        if (deduped.carried) {
          g.chunks.push(c);
          g.pieces.push(deduped.text);
          continue;
        }
      }
      groups.push({ chunks: [c], pieces: [c.text] });
    }
    const groupRange = (g: WindowGroup) =>
      rangeLabel(g.chunks[0].startLine, g.chunks[g.chunks.length - 1].endLine);
    const groupLabel = (g: WindowGroup) => `[${groupRange(g)}] ${headingLabel(g.chunks[0])}`;

    // Outline mode: a cheap structural map (one line per section, no body) so
    // the agent can target a ranged read instead of paging a full note.
    if (outline) {
      const lines = groups.map((g) => `${groupRange(g)}  ${headingLabel(g.chunks[0])}`).join("\n");
      const header = `${chunks[0].notePath} — outline of ${scope} (note spans ${noteSpan}):`;
      return clipContext(`${header}\n\n${lines}`, maxChars, "narrow with startLine/endLine");
    }

    // Assemble passages until `maxChars` of note text is reached. `maxChars` is a
    // hard ceiling on the body: if even the first passage exceeds it (a single
    // giant chunk — e.g. a note that is one unbroken paragraph), it is clipped so
    // an oversized indexed note can't return unbounded output.
    const blocks: string[] = [];
    let used = 0;
    let truncated = false;
    // 1-based line to continue from after a truncation; null when the cut fell
    // INSIDE the first passage (re-reading the same startLine with a larger
    // maxChars is then the only way forward).
    let continueAt: number | null = null;
    for (const g of groups) {
      if (truncated) break;
      const label = groupLabel(g);
      let blockText = "";
      for (let k = 0; k < g.pieces.length; k++) {
        const piece = g.pieces[k];
        const addition = (blockText ? "\n\n" : "") + piece;
        // First piece also pays for the label line and the inter-block gap.
        const overhead = blockText ? 0 : label.length + 1 + (blocks.length > 0 ? 2 : 0);
        if (used + overhead + addition.length > maxChars) {
          if (blocks.length === 0 && blockText === "") {
            blockText = piece.slice(0, Math.max(0, maxChars - label.length - 1));
            used += label.length + 1 + blockText.length;
          } else {
            // Truncation mid-group leaves the group label spanning the whole
            // section; the continuation pointer below is the accurate cursor.
            continueAt = g.chunks[k].startLine + 1;
          }
          truncated = true;
          break;
        }
        blockText += addition;
        used += overhead + addition.length;
      }
      if (blockText) blocks.push(`${label}\n${blockText}`);
    }

    const header = `${chunks[0].notePath} — ${scope}:`;
    const body = blocks.join("\n\n");
    if (!truncated) return `${header}\n\n${body}`;
    // A continuation pointer beats generic advice: without it the agent's
    // cheapest recovery is a full re-read of everything it already has. A
    // range-bounded read keeps its endLine, or the continuation would silently
    // widen the read past what the caller asked for.
    const endBound = endLine > 0 ? `, endLine=${endLine}` : "";
    const hint =
      continueAt !== null
        ? `continue with startLine=${continueAt}${endBound}; note spans ${noteSpan}`
        : `this passage alone exceeds maxChars — retry with a larger maxChars`;
    return `${header}\n\n${body}\n\n…(truncated at ${maxChars} chars; ${hint})`;
  },
};

const findRelatedNotesTool: Tool = {
  definition: {
    name: "find_related_notes",
    description:
      "Navigate the memory graph from one INDEXED note: returns the indexed notes " +
      "it links to and the indexed notes that link back to it. Links resolve by " +
      "note name (Obsidian-style); only notes in the index appear, and an excluded " +
      `or unindexed note is refused. Each direction lists up to ${RELATED_MAX_CHARS} ` +
      "characters of links; a hub note over that reports how many more it has.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path of the note to navigate from." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("find_related_notes", SEARCH_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const obj = requireObject(args, "arguments");
    const path = requireString(obj, "path", { maxLength: 1000 });
    const related = ctx.engine.getRelatedNotes(path);
    if (related.linksTo.length === 0 && related.linkedFrom.length === 0) {
      return `No linked notes found for "${path}".`;
    }
    const section = (title: string, notes: string[]) => {
      if (notes.length === 0) return "";
      const shown: string[] = [];
      let used = title.length + 1;
      for (const n of notes) {
        const line = `- ${n}\n`;
        // Always show at least one, so a single very deep path still resolves.
        if (shown.length > 0 && used + line.length > RELATED_MAX_CHARS) break;
        shown.push(n);
        used += line.length;
      }
      const body = `${title}:\n${shown.map((n) => `- ${n}`).join("\n")}`;
      const rest = notes.length - shown.length;
      // Name the remainder rather than truncating silently: a hub note's link
      // list is exactly where the agent needs to know it is seeing a slice.
      return rest > 0 ? `${body}\n- …(${rest} more, ${notes.length} total)` : body;
    };
    return [
      section("Links to", related.linksTo),
      section("Linked from", related.linkedFrom),
    ]
      .filter(Boolean)
      .join("\n\n");
  },
};

/**
 * The one-line label for a pending entry. Carries the timestamp for the same
 * reason the review modal does: it is the field that tells two similar
 * proposals apart.
 */
function pendingHead(e: {
  index: number;
  type: string;
  project?: string;
  timestampLabel: string;
}): string {
  const project = e.project ? `project: ${e.project}` : undefined;
  return [`#${e.index + 1}`, e.type, project, e.timestampLabel].filter(Boolean).join(" · ");
}

/**
 * Defuse block structure inside proposal content before it is rendered.
 *
 * The listing separates entries with `\n\n---\n\n` and heads each with `## `,
 * and proposal content is agent-supplied. Without this, one proposal whose
 * content contains a `---` line followed by a `## …` line renders as TWO
 * apparent entries — and the consequence lands precisely on this tool's
 * purpose: an agent that believes a fact is already pending suppresses a
 * genuine proposal, so a forged entry silently deletes memory that would
 * otherwise have been contributed.
 *
 * On-disk state is unaffected — `renderPendingBlock` owns the file format and
 * resolves its landmarks by position, so a forged line there loses to the real
 * one. This is the same defence applied to the rendered VIEW, and it mirrors
 * `neutralizeHeadings` in `pending-inbox.ts`: one leading space, which defeats
 * the anchored pattern and survives a round trip as ordinary prose.
 */
function neutralizeBlockStructure(content: string): string {
  return content
    .split("\n")
    .map((line) => (/^(#{1,6}\s|-{3,}\s*$)/.test(line) ? ` ${line}` : line))
    .join("\n");
}

/**
 * The shared shape of the two inbox listings (`list_pending_memory` and
 * `list_rejected_memory`).
 *
 * Both read one inbox-format file, filter it by project, and render it under
 * the same two cuts — an entry `limit` and a character budget. Those two cuts
 * have to drop the SAME end or they fight each other: `limit` keeps the tail of
 * an append-ordered file while a character clip always drops the end of the
 * text, so rendering oldest-first had the limit keep the newest entries and the
 * clip then throw them away. Reversing here makes both drop the oldest, once,
 * for both tools.
 *
 * `assembleLabeledBlocks` is deliberately not used: its omission tail tells the
 * agent to follow up with `get_note_context` on the paths it dropped, and these
 * entries have no path to read.
 */
function renderInboxListing(
  entries: PendingEntry[],
  limit: number,
  maxChars: number,
  noun: string,
): ToolResult {
  const newestFirst = entries.slice(-limit).reverse();
  const blocks = newestFirst.map((e) => {
    // `supersedes` is in the prose as well as the payload: it says this entry
    // claims to retire another, which is the single most consequential thing
    // about it and not something a reviewer or an agent should have to read
    // fields to discover.
    const claims = e.supersedes ? `\n\nReplaces: ${neutralizeBlockStructure(e.supersedes)}` : "";
    const why = e.reason ? `\n\nReason: ${neutralizeBlockStructure(e.reason)}` : "";
    return `## ${pendingHead(e)}${claims}${why}\n\n${neutralizeBlockStructure(e.content.trim())}`;
  });
  // ONE decision about what this page contains, used for both halves.
  const page = sliceToFit(maxChars, newestFirst, blocks, 7); // "\n\n---\n\n"
  const shown = page.items;
  const body = page.blocks.join("\n\n---\n\n");
  const preamble =
    shown.length === entries.length
      ? `${entries.length} ${noun}, newest first.`
      : `${entries.length} ${noun}; showing the ${shown.length} newest.`;
  const text = clipContext(
    `${preamble}\n\n${body}`,
    maxChars,
    "raise `limit` or narrow by `project`",
  );
  return {
    text,
    // Built from the same slice the prose was, and each entry's own text bounded
    // the same way — otherwise `maxChars` bounds only the channel a caller
    // happens not to be reading. `total` carries what was cut.
    structured: {
      total: entries.length,
      entries: shown.map((e) => inboxEntryRecord(e, maxChars)),
    },
  };
}

/** The `project` / `limit` / `maxChars` arguments both inbox listings take. */
function inboxListingArgs(args: unknown): { project: string; limit: number; maxChars: number } {
  const obj = requireObject(args, "arguments");
  return {
    project: optionalString(obj, "project", "", 200).trim(),
    limit: Math.trunc(
      optionalNumber(obj, "limit", PENDING_DEFAULT_LIMIT, { min: 1, max: PENDING_MAX_LIMIT }),
    ),
    maxChars: contextMaxChars(obj),
  };
}

/** The shared `inputSchema` for both inbox listings. */
const INBOX_LISTING_SCHEMA = {
  type: "object",
  properties: {
    project: {
      type: "string",
      description: "Only entries for this project. Omit for all entries.",
    },
    limit: {
      type: "number",
      description: `Max entries (1–${PENDING_MAX_LIMIT}, default ${PENDING_DEFAULT_LIMIT}).`,
    },
    maxChars: MAX_CHARS_SCHEMA,
    tokenBudget: TOKEN_BUDGET_SCHEMA,
  },
  additionalProperties: false,
} as const;

/**
 * `list_pending_memory` — let the agent see the proposals it made.
 *
 * `add_memory` appends to the review inbox and returns only that it landed, so
 * an agent could not tell an accepted memory from a rejected one from a still
 * pending one. It re-proposed facts it had already contributed, and the
 * writer's dedup silently absorbed them — a loop that was open in one
 * direction, and the reason memory quality decayed across sessions rather than
 * accumulating.
 *
 * READ ONLY, and deliberately so. Applying an entry stays out of `ALL_TOOLS`
 * entirely: promotion is the human review step the whole inbox design exists
 * for, and a tool that could approve its own proposal would collapse that. This
 * tool cannot write, apply, or discard anything — it reports what a reviewer
 * has yet to act on.
 *
 * It reads only `pending-memory.md` through `MemoryWriter.readInbox`, which
 * returns an empty parse when the file does not exist, so it is not a general
 * file reader and cannot be aimed anywhere else.
 */
const listPendingMemoryTool: Tool = {
  definition: {
    name: "list_pending_memory",
    description:
      "List memory proposals awaiting human review in the inbox, newest first. " +
      "Use this before proposing, to avoid re-proposing something already pending. " +
      "Read-only: approving or discarding an entry is done by a person in Obsidian.",
    inputSchema: INBOX_LISTING_SCHEMA,
    outputSchema: INBOX_OUTPUT_SCHEMA,
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("list_pending_memory", CONTEXT_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const { project, limit, maxChars } = inboxListingArgs(args);
    // The project match is the engine's rule, not the transport's: it is a
    // domain question, and this file is the wrong place for a second, subtly
    // different answer to it.
    const matching = (await ctx.engine.getPendingMemory({ project })).entries;
    if (matching.length === 0) {
      return {
        text:
          project === ""
            ? "No memory proposals are awaiting review."
            : `No memory proposals awaiting review for "${project}".`,
        structured: { total: 0, entries: [] },
      };
    }
    return renderInboxListing(matching, limit, maxChars, "awaiting review");
  },
};

/**
 * `get_recent_changes` — what moved since the agent last looked.
 *
 * Paths and dates, never content: the follow-up is `get_note_context` on
 * whichever paths matter, which keeps the agent in control of what it spends
 * context on. See `EngramEngine.getChangedNotes` for why this is a map read
 * rather than a search, and for the exclusion property it rests on.
 */
/**
 * `list_rejected_memory` — the other half of the feedback loop.
 *
 * `list_pending_memory` told the agent what a reviewer has yet to act on. This
 * tells it what they acted on by saying no, and why. Without it, a rejection is
 * indistinguishable from an entry that simply has not been reviewed yet, so the
 * agent's only rational move is to keep proposing — which is what filled review
 * inboxes with facts their owner had already turned down.
 *
 * READ ONLY, and for the same reason `list_pending_memory` is: the ledger is a
 * record of human decisions. Clearing it (un-rejecting a memory) is a UI action
 * and is never exposed over the network.
 */
const listRejectedMemoryTool: Tool = {
  definition: {
    name: "list_rejected_memory",
    description:
      "List memory proposals a reviewer discarded, with their reasons, newest first. " +
      "Read this when a proposal comes back as rejected, or before re-proposing " +
      "something from an earlier session. Read-only.",
    inputSchema: INBOX_LISTING_SCHEMA,
    outputSchema: INBOX_OUTPUT_SCHEMA,
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("list_rejected_memory", CONTEXT_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const { project, limit, maxChars } = inboxListingArgs(args);
    const matching = (await ctx.engine.getRejectedMemory({ project })).entries;
    if (matching.length === 0) {
      return {
        text:
          project === ""
            ? "No memory proposals have been rejected."
            : `No rejected memory proposals for "${project}".`,
        structured: { total: 0, entries: [] },
      };
    }
    return renderInboxListing(matching, limit, maxChars, "rejected");
  },
};

const getRecentChangesTool: Tool = {
  definition: {
    name: "get_recent_changes",
    description:
      "List indexed notes changed recently, newest first, as paths and dates. " +
      "Use at the start of a session to see what moved since you last worked here, " +
      "then read the ones that matter with get_note_context. Returns no note content.",
    inputSchema: {
      type: "object",
      properties: {
        sinceDays: {
          type: "number",
          description: `Look back this many days (0–${CHANGES_MAX_DAYS}, default ${CHANGES_DEFAULT_DAYS}). Fractions are allowed: 1 hour is about 0.04. 0 means no lower bound, matching search_vault_memory.`,
        },
        limit: {
          type: "number",
          description: `Max notes (1–${CHANGES_MAX_LIMIT}, default ${CHANGES_DEFAULT_LIMIT}).`,
        },
        maxChars: MAX_CHARS_SCHEMA,
        tokenBudget: TOKEN_BUDGET_SCHEMA,
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        indexed: { type: "number" },
        notes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              modified: { type: "string" },
              modifiedAt: { type: "number" },
            },
            required: ["path", "modifiedAt"],
          },
        },
      },
      required: ["indexed", "notes"],
    },
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("get_recent_changes", CONTEXT_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const obj = requireObject(args, "arguments");
    // Fractional days on purpose: "what changed in the last hour" is the
    // question a resuming agent actually has, and a whole-day floor would make
    // it unaskable. `0` is accepted and means no lower bound, because that is
    // what it already means to `search_vault_memory` — the same argument name
    // advertising two incompatible domains across one tool surface is how an
    // agent carries a value over and gets a validation error instead of the
    // widest window.
    const sinceDays = optionalNumber(obj, "sinceDays", CHANGES_DEFAULT_DAYS, {
      min: 0,
      max: CHANGES_MAX_DAYS,
    });
    const limit = Math.trunc(
      optionalNumber(obj, "limit", CHANGES_DEFAULT_LIMIT, { min: 1, max: CHANGES_MAX_LIMIT }),
    );
    const maxChars = contextMaxChars(obj);

    // `0` is "no lower bound", not "a cutoff at this instant" — the arithmetic
    // alone would make it the emptiest possible window rather than the widest,
    // which is the opposite of what it means to `search_vault_memory`.
    const sinceMs = sinceDays === 0 ? Number.NEGATIVE_INFINITY : ctx.clock() - sinceDays * MS_PER_DAY;
    const { indexed, changed } = ctx.engine.getChangedNotes(sinceMs, limit);
    if (indexed === 0) {
      // Distinguished from "nothing changed": an empty index means the answer
      // is unknown, not negative, and the fix is a reindex rather than a wider
      // window. Conflating them is how an agent concludes a vault is idle.
      // Both facts come from one call so they cannot disagree.
      return {
        text: "The index is empty, so no change history is available. Run reindex_vault first.",
        // `indexed: 0` is what tells a structured consumer this is "unknown",
        // not "nothing changed" — the same distinction the prose makes.
        structured: { indexed: 0, notes: [] },
      };
    }
    const window = sinceDays === 0 ? "ever recorded" : `in the last ${sinceDays} day(s)`;
    if (changed.length === 0) {
      return { text: `No indexed notes changed ${window}.`, structured: { indexed, notes: [] } };
    }
    const lines = changed.map((c) => `${c.path} — ${formatModifiedDate(c.mtime)}`);
    // Same one-decision rule as the inbox listings: the payload must describe
    // the notes the prose actually listed, not the ones it would have.
    const page = sliceToFit(maxChars, changed, lines, 1);
    const shown = page.items;
    const body = `${shown.length} changed ${window}, newest first:\n\n${page.blocks.join("\n")}`;
    return {
      text: clipContext(body, maxChars, "narrow `sinceDays` or lower `limit`"),
      structured: {
        indexed,
        notes: shown.map((c) => ({
          path: c.path,
          modified: formatModifiedDate(c.mtime),
          modifiedAt: c.mtime,
        })),
      },
    };
  },
};

/**
 * `resolve_project` — turn a working directory into the project name that
 * actually exists.
 *
 * The agent knows a filesystem path; this plugin knows a folder name a person
 * chose. Nothing connects them, so an agent had to guess on every call — and a
 * near miss returned an empty context indistinguishable from a project with
 * nothing in it yet, which is the worst possible failure for a memory tool
 * because it reads as "no memory" rather than "wrong name".
 *
 * The hint is TEXT, never a path: only its last segment is used, nothing is
 * resolved, and no filesystem outside the vault is touched. Matching runs over
 * names `list_projects` already returns, so this exposes nothing new.
 */
const resolveProjectTool: Tool = {
  definition: {
    name: "resolve_project",
    description:
      "Map a working directory, repository name, or guess to the project name this vault " +
      "actually uses, so project-scoped calls do not silently miss. Returns the exact match, " +
      "or near matches, or — when two project names differ only by punctuation or case — both " +
      "of them, so you pick rather than being given a confident guess. " +
      "Call before get_project_context if unsure.",
    inputSchema: {
      type: "object",
      properties: {
        hint: {
          type: "string",
          description:
            "A working-directory path, repository name, or guess — e.g. /home/u/Git/coder-engram.",
        },
      },
      required: ["hint"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        exact: { type: ["string", "null"] },
        ambiguous: { type: "array", items: { type: "string" } },
        candidates: { type: "array", items: { type: "string" } },
        all: { type: "array", items: { type: "string" } },
      },
      required: ["exact", "ambiguous", "candidates", "all"],
    },
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("resolve_project", CONTEXT_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const obj = requireObject(args, "arguments");
    const hint = requireString(obj, "hint", { maxLength: 1000 });
    const { exact, ambiguous, candidates, all } = await ctx.engine.resolveProject(hint);
    // One structured answer for every branch below, so a consumer reads the
    // same four fields whatever the outcome — the prose says which branch it
    // is, and `exact === null` with an empty `ambiguous` says the same thing
    // in data.
    const structured = {
      exact,
      ambiguous,
      candidates: candidates.slice(0, PROJECT_LIST_MAX),
      all: all.slice(0, PROJECT_LIST_MAX),
    };
    if (ambiguous.length > 0) {
      // Two projects whose names differ only by separator or case. Naming one
      // as "the" match would be a confident wrong answer, which is worse here
      // than no answer: the agent would never learn the other exists.
      return {
        text:
          `"${hint}" matches more than one project:\n\n${ambiguous.join("\n")}\n\n` +
          `They differ only by punctuation or case. Pass the exact name you mean as \`project\`.`,
        structured,
      };
    }
    if (exact !== null) {
      // Near matches are deliberately NOT appended here. On the one branch
      // where the answer is unambiguous, they are noise the agent has no use
      // for — and every extra clause is another thing to keep true.
      return {
        text: `${exact}\n\nExact match — use this as the \`project\` argument.`,
        structured,
      };
    }
    if (candidates.length > 0) {
      return {
        text:
          `No exact match for "${hint}". Near matches:\n\n${structured.candidates.join("\n")}\n\n` +
          `Pass one of these as \`project\`, or create it with the Create Project Memory Folder command.`,
        structured,
      };
    }
    // Naming what exists beats a bare "not found": the usual cause is that the
    // project has not been created yet, and an agent cannot tell that apart
    // from a spelling miss without seeing the list. `all` came back with the
    // match above rather than from a second vault scan.
    if (all.length === 0) {
      return {
        text: `No projects exist yet. Create one with the Create Project Memory Folder command in Obsidian.`,
        structured,
      };
    }
    // Says how many it hid, like `list_projects` does. Silently truncating is
    // the same failure this tool exists to remove: an agent told a project does
    // not exist, when it was item 26.
    const hidden = all.length - structured.all.length;
    const more = hidden > 0 ? `\n\n…(${hidden} more not shown)` : "";
    return {
      text: `No project matches "${hint}". Existing projects:\n\n${structured.all.join("\n")}${more}`,
      structured,
    };
  },
};

/**
 * `search_batch` — several related questions, one call, one budget.
 *
 * An agent exploring a topic asks three or four overlapping questions, and one
 * at a time that is three or four round trips returning heavily overlapping
 * results, each paid for separately in context. Batching lets the overlap be
 * removed ONCE, which is the actual saving: a chunk that answers three of the
 * questions is returned a single time, annotated with which ones it answered.
 *
 * Fused by Reciprocal Rank Fusion, the same rank-based combination the hybrid
 * retriever uses to merge lexical with vector — for the same reason. Scores
 * from different queries are not comparable, so combining them by rank is the
 * only honest way to interleave them.
 *
 * This is NOT cheaper than the individual calls in vector or hybrid mode: each
 * query still embeds separately. What it saves is round trips and duplicated
 * context, not provider work.
 */
const searchBatchTool: Tool = {
  definition: {
    name: "search_batch",
    description:
      "Run several related queries in one call and get one merged, de-duplicated result page. " +
      "Each result says which of your queries it answered. Use when exploring a topic from a " +
      "few angles at once; use search_vault_memory for a single question.",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description: `The questions (1–${BATCH_MAX_QUERIES}). Related but distinct works best.`,
        },
        limit: {
          type: "number",
          description: `Max merged results (1–${SEARCH_MAX_LIMIT}, default ${SEARCH_DEFAULT_LIMIT}).`,
        },
        folder: { type: "string", description: "Restrict to notes under this vault-relative folder." },
        tag: { type: "string", description: "Restrict to notes carrying this tag (no leading #)." },
        project: { type: "string", description: "Restrict to a project under the projects root." },
        sinceDays: { type: "number", description: "Only notes modified within this many days." },
        tokenBudget: TOKEN_BUDGET_SCHEMA,
      },
      required: ["queries"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" } },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ...SEARCH_RESULT_ITEM_SCHEMA.properties,
              matchedQueries: { type: "array", items: { type: "number" } },
            },
            required: [...SEARCH_RESULT_ITEM_SCHEMA.required, "matchedQueries"],
          },
        },
      },
      required: ["queries", "results"],
    },
  },
  async handler(args, ctx) {
    // Charged in two steps, and the order matters. First under this tool's own
    // name BEFORE any validation, because a limiter consulted after validation
    // makes a flood of malformed calls free to send and never bounded.
    ctx.rateLimiter.enforceWindow("search_batch", SEARCH_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const obj = requireObject(args, "arguments");
    const raw = optionalStringArray(obj, "queries", BATCH_MAX_QUERIES, 2000);
    const queries = raw.map((q) => q.trim()).filter((q) => q !== "");
    if (queries.length === 0) {
      throw new ValidationError(`Field "queries" must contain at least one non-blank query`);
    }
    // Then once per query against the SEARCH budget, so a batch of five costs
    // what five searches cost. Without this, batching is simply the cheap way
    // around the search limit.
    for (let i = 0; i < queries.length; i++) {
      ctx.rateLimiter.enforceWindow("search_vault_memory", SEARCH_MAX_PER_MINUTE, RATE_WINDOW_MS);
    }

    const { limit, filters } = parseSearchScope(obj, ctx);
    const budget = tokenBudgetChars(obj);

    // Running the queries and fusing them is the ENGINE's job — it is ranking,
    // not transport. See `EngramEngine.searchBatch`.
    const fused = await ctx.engine.searchBatch(queries, { limit, filters });

    if (fused.length === 0) {
      return {
        text: `No results for any of: ${queries.map((q) => `"${q}"`).join(", ")}.`,
        structured: { queries, results: [] },
      };
    }

    const distinct = applyContextSavings(fused, limit, ctx.settings);

    const pendingPath = ctx.engine.getPaths().pendingMemoryFile;
    const blocks = distinct.map((r, i) => {
      // Named so the agent can tell a chunk that answered one question from one
      // that answered several — the second is usually the better memory, and
      // that signal is lost entirely when the queries are run separately.
      // `sources` is 0-based from fusion; the header numbers queries from 1.
      const which = ` [q${r.sources.map((n) => n + 1).join(",")}]`;
      return `${i + 1}. ${searchResultLabel(r, pendingPath)}${which}\n${r.snippet}`;
    });
    const asked = queries.map((q, i) => `q${i + 1}: "${q}"`).join("\n");
    const page = budget === null ? { items: distinct, blocks } : sliceToFit(budget, distinct, blocks, 2);
    const text = `${page.items.length} merged result(s) for:\n${asked}\n\n${page.blocks.join("\n\n")}`;
    return {
      text,
      structured: {
        queries,
        estimatedTokens: estimateTokens(text),
        results: page.items.map((r) => ({
          ...searchResultRecord(r, pendingPath),
          // 0-based from fusion, as the prose's `[q1,q3]` is 1-based. Named
          // rather than renumbered so a consumer can index `queries` directly.
          matchedQueries: r.sources,
        })),
      },
    };
  },
};

const ALL_TOOLS: Tool[] = [
  searchTool,
  addMemoryTool,
  summarizeNoteTool,
  getNoteContextTool,
  findRelatedNotesTool,
  getProjectContextTool,
  getGlobalContextTool,
  listProjectsTool,
  listPendingMemoryTool,
  listRejectedMemoryTool,
  getRecentChangesTool,
  resolveProjectTool,
  searchBatchTool,
  getRecentSessionsTool,
  reindexTool,
];

/** Registry that resolves tool names to definitions and handlers. */
export class ToolRegistry {
  private readonly byName = new Map<string, Tool>();

  constructor(tools: Tool[] = ALL_TOOLS) {
    for (const t of tools) this.byName.set(t.definition.name, t);
  }

  list(): ToolDefinition[] {
    return [...this.byName.values()].map((t) => t.definition);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /**
   * Invoke a tool by name; throws ValidationError for an unknown tool.
   *
   * Handlers may return a bare string — most do, and nothing is gained by
   * making a one-line answer carry an envelope — so the result is normalized
   * here rather than at every `return`.
   */
  async call(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.byName.get(name);
    if (!tool) {
      throw new ValidationError(`Unknown tool: ${name}`);
    }
    const out = await tool.handler(args, ctx);
    return typeof out === "string" ? { text: out } : out;
  }

  /**
   * The prose half of {@link call}, for callers that only want what the model
   * reads. Test support: the protocol layer needs the whole result so it can
   * emit `structuredContent`, and nothing in production wants one half of it.
   */
  async callText(name: string, args: unknown, ctx: ToolContext): Promise<string> {
    return (await this.call(name, args, ctx)).text;
  }
}
