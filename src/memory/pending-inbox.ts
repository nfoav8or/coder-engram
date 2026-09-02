/**
 * pending-inbox — pure parse / serialize / routing for the review inbox
 * (`Memory/Inbox/pending-memory.md`).
 *
 * The inbox is human-readable Markdown produced by {@link renderPendingBlock}:
 * a `## Pending Memory: <timestamp>` heading, a few `Key: value` lines, a
 * `Content:` body, an optional `Related files:` list, and a `Status:` line,
 * terminated by a `---` delimiter. There is no per-entry machine ID on disk, so
 * entries are addressed by their exact raw block text (see {@link removeEntry}).
 *
 * Everything here is pure and Obsidian-free so the richer review UI and the
 * MemoryWriter can share one source of truth for the format. `renderPendingBlock`
 * is the single format producer — `formatMemoryEntry` (memory-writer) delegates
 * to it, so parse ⇄ render round-trips.
 */

import { MemoryPaths, resolveProjectPaths } from "./memory-types";
import { scanMarkdownLines } from "../core/markdown-chunker";
import { fnv1a32 } from "../utils/hash";

/** The header written above the first entry when the inbox file is created. */
export const INBOX_HEADER =
  "# Pending Memory Inbox\n\n" +
  "Reviewable memory proposed by Coder Engram. Apply or discard entries as you see fit.\n\n" +
  "---\n\n";

/** The header written above the first record when the rejection ledger is created. */
export const REJECTED_HEADER =
  "# Rejected Memory\n\n" +
  "Proposals you discarded, newest last. Coder Engram reports these to the agent so it\n" +
  "stops re-proposing them, and refuses an identical proposal while the record stands.\n" +
  "Delete a record here to let that memory be proposed again.\n\n" +
  "---\n\n";

/** The header written above the first record when the supersession ledger is created. */
export const SUPERSEDED_HEADER =
  "# Superseded Memory\n\n" +
  "Memories retired by a later one you applied, newest last. Coder Engram stops\n" +
  "returning a superseded memory from search and from project/global context; the\n" +
  "original text is left untouched in its file.\n" +
  "Delete a record here to bring that memory back.\n\n" +
  "---\n\n";

/** Base tag applied to every proposed/graduated memory entry. */
export const BASE_TAG = "coder-engram";
/** Tag written by pre-rename releases (≤0.4.0); still stripped at parse so
 * existing inbox blocks round-trip without surfacing it as a user tag. */
const LEGACY_BASE_TAG = "claude-code-engram";

/** Heading that opens a block in the review inbox. */
export const PENDING_HEADING_PREFIX = "## Pending Memory: ";
/**
 * Heading that opens a block in the rejection ledger. The ledger reuses this
 * module's block format so there is still exactly ONE producer of the on-disk
 * shape; only the heading distinguishes the two files.
 */
export const REJECTED_HEADING_PREFIX = "## Rejected Memory: ";
/** Heading that opens a record in the supersession ledger. */
export const SUPERSEDED_HEADING_PREFIX = "## Superseded Memory: ";
/** Every heading that opens a block, whichever file it lives in. Content is
 * neutralized against ALL of them, not just the one it is being written to:
 * proposal content is copied verbatim into the ledger when it is discarded, so
 * a `## Rejected Memory: ` line that is inert in the inbox would forge a ledger
 * entry the moment a reviewer rejects it. */
const HEADING_PREFIXES = [
  PENDING_HEADING_PREFIX,
  REJECTED_HEADING_PREFIX,
  SUPERSEDED_HEADING_PREFIX,
];
const RELATED_HEADER = "Related files:";

/** Normalize + dedupe tags, always leading with the base tag, each `#`-prefixed. */
export function formatTags(tags: string[]): string {
  const base = [BASE_TAG];
  const extra = tags
    // A tag cannot contain whitespace: the parser splits the Tags line on it,
    // so a tag carrying a newline would otherwise become several tags — or, at
    // the start of a line, a forged field.
    .map((t) => t.trim().replace(/^#+/, "").replace(/\s+/g, "-"))
    .filter(Boolean);
  return Array.from(new Set([...base, ...extra])).map((t) => `#${t}`).join(" ");
}

/** The structured fields of one pending-memory block. */
export interface PendingBlockFields {
  /** Human-readable timestamp label as written in the heading. */
  timestampLabel: string;
  type: string;
  project?: string;
  source: string;
  originTool?: string;
  confidence?: string;
  /** Why a reviewer rejected this proposal. Only ever set in the ledger. */
  reason?: string;
  /**
   * `<vault path>#<heading>` of the memory this entry replaces, when the
   * proposal claims to supersede one. Validated against the memory root before
   * it is ever acted on; see `memory/supersession.ts`.
   */
  supersedes?: string;
  /**
   * `<vault path>#<heading>` of an existing memory this proposal overlaps.
   * Computed by the engine at propose time and never accepted from a caller —
   * it is an observation about the vault, not a claim the proposer gets to make.
   */
  similarTo?: string;
  /** Tags WITHOUT the leading `#`; the base tag is added on render. */
  tags: string[];
  content: string;
  relatedPaths: string[];
  status: string;
}

/**
 * Collapse a value that must occupy exactly one line.
 *
 * Every field but `content` is single-line, and the parser reads this file line
 * by line — so a newline inside one of them is not bad data, it is a forged
 * line. An `add_memory` caller that put "x\nStatus: applied" in a tag really did
 * write a Status line into the block. These values (a type, a source, a vault
 * path) have no legitimate newline, so collapsing is lossless in practice.
 */
function oneLine(value: string): string {
  // U+2028/U+2029 (LINE/PARAGRAPH SEPARATOR) aren't `\n`, so they don't affect
  // parsing, but some Markdown renderers treat them as a hard line break —
  // collapsed here too so a single-line field can't display as multiple lines.
  return value.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
}

/**
 * Neutralize a block heading appearing inside content, which IS legitimately
 * multi-line. `parsePendingInbox` splits entries on the heading prefix, so
 * content containing that at the start of a line would forge a whole second
 * entry. One leading space defeats the anchored split and survives a
 * render→parse→render round trip (the line no longer matches, so it is not
 * indented again).
 */
function neutralizeHeadings(content: string): string {
  return content
    .split("\n")
    .map((l) => (HEADING_PREFIXES.some((h) => l.startsWith(h)) ? ` ${l}` : l))
    .join("\n");
}

/**
 * Neutralize a content TAIL that is byte-identical to a real "Related files:"
 * section (a bare `Related files:` line, a blank, then only bullets to the end
 * of the content). When no real section follows, the parser cannot tell that
 * shape apart from structure — it would silently move the tail out of
 * `content` and into `relatedPaths`. One leading space on that one line keeps
 * it content forever; every other placement of the phrase is left verbatim
 * because the parser's shape check (`isRelatedSection`) already resolves it.
 */
function neutralizeRelatedTail(content: string): string {
  const lines = content.split("\n");
  const idx = lastIndexOf(lines, (l) => l === RELATED_HEADER);
  if (idx < 0 || !isRelatedSection(lines, idx + 1, lines.length)) return content;
  lines[idx] = ` ${lines[idx]}`;
  return lines.join("\n");
}

/**
 * Render a pending-memory block. This is the ONE format producer for the inbox;
 * `formatMemoryEntry` delegates here so the on-disk format never drifts.
 *
 * Field values are agent-supplied (`add_memory` is reachable over the local
 * server), so they are neutralized here rather than at each caller — this is
 * the only place that knows which parts of the format are structural.
 */
export function renderPendingBlock(
  f: PendingBlockFields,
  headingPrefix: string = PENDING_HEADING_PREFIX,
): string {
  // Every optional field is gated on its COLLAPSED value, not its raw one.
  // `oneLine` can reduce a truthy input (a lone "\n", say) to "", and the
  // parser maps an empty field back to `undefined` — so gating on the raw
  // value emitted "Project: " and lost the field on the next parse, breaking
  // the parse-render round-trip this module's contract rests on. Blank related
  // paths are dropped for the sharper version of the same problem: `* ` with
  // nothing after it is a malformed bullet in a file the user reads, and the
  // parser's `^\*\s+(.+)$` then silently drops it, so the parsed view
  // under-reports what is on disk. `add_memory` reaches this with
  // `relatedPaths: [""]` — `optionalStringArray` checks type and length, not
  // blankness.
  const lines: string[] = [];
  const project = oneLine(f.project ?? "");
  const originTool = oneLine(f.originTool ?? "");
  const confidence = oneLine(f.confidence ?? "");
  const reason = oneLine(f.reason ?? "");
  const supersedes = oneLine(f.supersedes ?? "");
  const similarTo = oneLine(f.similarTo ?? "");
  const relatedPaths = f.relatedPaths.map(oneLine).filter((p) => p !== "");
  lines.push(`${headingPrefix}${oneLine(f.timestampLabel)}`);
  lines.push("");
  lines.push(`Type: ${oneLine(f.type)}`);
  if (project) lines.push(`Project: ${project}`);
  lines.push(`Source: ${oneLine(f.source)}`);
  if (originTool) lines.push(`Origin: ${originTool}`);
  if (confidence) lines.push(`Confidence: ${confidence}`);
  if (supersedes) lines.push(`Supersedes: ${supersedes}`);
  if (similarTo) lines.push(`Similar: ${similarTo}`);
  if (reason) lines.push(`Reason: ${reason}`);
  lines.push(`Tags: ${formatTags(f.tags)}`);
  lines.push("");
  lines.push("Content:");
  lines.push("");
  const content = neutralizeHeadings(f.content.trim());
  lines.push(relatedPaths.length > 0 ? content : neutralizeRelatedTail(content));
  if (relatedPaths.length > 0) {
    lines.push("");
    lines.push(RELATED_HEADER);
    lines.push("");
    for (const p of relatedPaths) lines.push(`* ${p}`);
  }
  lines.push("");
  // A blank status parses back as "pending"; writing that literally keeps the
  // file saying what the parser will read from it.
  lines.push(`Status: ${oneLine(f.status) || "pending"}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

/** One parsed inbox entry: its structured fields plus the exact raw block that
 * produced it (used to locate and remove it without a stable on-disk ID). */
export interface PendingEntry extends PendingBlockFields {
  /** Zero-based position within the inbox, in file order. */
  index: number;
  /** The exact block text (heading through the trailing `---`), used to match
   * this entry back in the file for apply/discard. */
  raw: string;
}

export interface ParsedInbox {
  /** Everything before the first entry (the file header), preserved verbatim. */
  header: string;
  entries: PendingEntry[];
}

const FIELD_LINE = /^([A-Za-z][A-Za-z ]*?):\s?(.*)$/;

/** Escape a literal heading prefix for use inside an anchored RegExp. */
function headingPattern(prefix: string): RegExp {
  return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
}

/**
 * Parse an inbox-format file into its header and structured entries. Pass
 * `headingPrefix` to parse the rejection ledger, which shares the block format
 * and differs only in its heading.
 */
export function parsePendingInbox(
  text: string,
  headingPrefix: string = PENDING_HEADING_PREFIX,
): ParsedInbox {
  const heading = headingPattern(headingPrefix);
  const firstIdx = text.match(heading)?.index ?? -1;
  if (firstIdx < 0) {
    return { header: text, entries: [] };
  }
  const header = text.slice(0, firstIdx);
  const rest = text.slice(firstIdx);
  // Split into per-entry blocks on each heading (keep the heading with its block).
  const blocks = rest
    .split(new RegExp(`(?=${heading.source})`, "m"))
    .filter((b) => b.trim().length > 0);
  const entries: PendingEntry[] = [];
  blocks.forEach((raw, index) => {
    const parsed = parseBlock(raw, index, headingPrefix);
    if (parsed) entries.push(parsed);
  });
  return { header, entries };
}

/** Serialize a header + entries back into inbox text (entries keep their raw). */
export function serializePendingInbox(header: string, entries: PendingEntry[]): string {
  if (entries.length === 0) return header;
  return header + entries.map((e) => e.raw).join("");
}

/**
 * Remove the entry whose raw block matches `target.raw` and return the rewritten
 * inbox text. Matches the FIRST exact raw match. Returns `null` if no entry
 * matched (the file changed under us — the caller should refresh).
 */
export function removeEntry(
  text: string,
  target: PendingEntry,
  headingPrefix: string = PENDING_HEADING_PREFIX,
): string | null {
  const { header, entries } = parsePendingInbox(text, headingPrefix);
  const idx = entries.findIndex((e) => e.raw === target.raw);
  if (idx < 0) return null;
  const remaining = entries.filter((_, i) => i !== idx);
  return serializePendingInbox(header, remaining);
}

function parseBlock(raw: string, index: number, headingPrefix: string): PendingEntry | null {
  const lines = raw.split("\n");
  const heading = lines[0] ?? "";
  if (!heading.startsWith(headingPrefix)) return null;
  const timestampLabel = heading.slice(headingPrefix.length).trim();

  // Structural landmarks. Content lines may themselves look like `Key: value`
  // or `---`, so bound content by landmarks found from known positions rather
  // than by scanning for the first match.
  const contentIdx = lines.findIndex((l) => l === "Content:");
  const delimIdx = lastIndexOf(lines, (l) => l.trim() === "---");
  // The structural Status line is the last `Status:` line before the delimiter.
  const statusIdx = lastIndexOf(
    lines,
    (l) => /^Status:\s?/.test(l),
    delimIdx >= 0 ? delimIdx : lines.length,
  );
  // A `Related files:` line is only a STRUCTURAL landmark when it is followed
  // solely by `* path` bullets up to the Status/delimiter — otherwise it's just
  // content that happens to contain the phrase (plausible for a code-memory
  // note), and treating it as structural would truncate the content.
  const relatedEnd = statusIdx >= 0 ? statusIdx : delimIdx >= 0 ? delimIdx : lines.length;
  let relatedIdx = lastIndexOf(lines, (l) => l === "Related files:", relatedEnd);
  if (relatedIdx >= 0 && !isRelatedSection(lines, relatedIdx + 1, relatedEnd)) {
    relatedIdx = -1;
  }

  // Header key/value lines live before `Content:`.
  const headerEnd = contentIdx >= 0 ? contentIdx : lines.length;
  const fields = new Map<string, string>();
  for (let i = 1; i < headerEnd; i++) {
    const m = lines[i].match(FIELD_LINE);
    if (m) fields.set(m[1].trim().toLowerCase(), m[2].trim());
  }

  // Content: from after `Content:` (+ its blank line) up to Related/Status.
  let contentEnd = lines.length;
  if (relatedIdx >= 0 && (contentIdx < 0 || relatedIdx > contentIdx)) contentEnd = relatedIdx;
  else if (statusIdx >= 0 && (contentIdx < 0 || statusIdx > contentIdx)) contentEnd = statusIdx;
  const contentStart = contentIdx >= 0 ? contentIdx + 1 : lines.length;
  const content = lines.slice(contentStart, contentEnd).join("\n").trim();

  // Related files: `* path` lines between the Related heading and Status.
  const relatedPaths: string[] = [];
  if (relatedIdx >= 0) {
    const relEnd = statusIdx >= 0 ? statusIdx : delimIdx >= 0 ? delimIdx : lines.length;
    for (let i = relatedIdx + 1; i < relEnd; i++) {
      const m = lines[i].match(/^\*\s+(.+)$/);
      if (m) relatedPaths.push(m[1].trim());
    }
  }

  const tagsRaw = fields.get("tags") ?? "";
  const tags = tagsRaw
    .split(/\s+/)
    .map((t) => t.replace(/^#+/, "").trim())
    .filter((t) => t && t !== BASE_TAG && t !== LEGACY_BASE_TAG);

  const statusLine = statusIdx >= 0 ? lines[statusIdx] : "";
  const status = statusLine.replace(/^Status:\s?/, "").trim() || "pending";

  return {
    index,
    raw,
    timestampLabel,
    type: fields.get("type") ?? "note",
    project: fields.get("project") || undefined,
    source: fields.get("source") ?? "",
    originTool: fields.get("origin") || undefined,
    confidence: fields.get("confidence") || undefined,
    reason: fields.get("reason") || undefined,
    supersedes: fields.get("supersedes") || undefined,
    similarTo: fields.get("similar") || undefined,
    tags,
    content,
    relatedPaths,
    status,
  };
}

/**
 * True when [start, end) has the exact shape our emitter produces for a real
 * "Related files:" block: a blank line immediately after the header, then one
 * or more `* …` bullets (and nothing else non-blank). Requiring the leading
 * blank distinguishes a genuine section from note content that merely contains
 * a "Related files:" line followed directly by bullets. `start` is the index of
 * the line immediately after the "Related files:" header.
 */
function isRelatedSection(lines: string[], start: number, end: number): boolean {
  if (start >= end || lines[start].trim() !== "") return false;
  let sawBullet = false;
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (/^\*\s+/.test(line)) sawBullet = true;
    else return false;
  }
  return sawBullet;
}

function lastIndexOf(lines: string[], pred: (l: string) => boolean, before = lines.length): number {
  for (let i = Math.min(before, lines.length) - 1; i >= 0; i--) {
    if (pred(lines[i])) return i;
  }
  return -1;
}

// --- apply routing -----------------------------------------------------------

/**
 * Resolve the destination memory file a pending entry graduates INTO when the
 * user applies it. Project entries land in the matching project file by type;
 * global entries land in the global file whose purpose best fits the type. The
 * returned path is a vault-relative path already resolved inside the memory root
 * (via {@link resolveProjectPaths} / {@link MemoryPaths}); the MemoryWriter
 * re-validates it against the root before writing.
 */
export function resolveApplyDestination(entry: PendingEntry, paths: MemoryPaths): string {
  if (entry.project) {
    const p = resolveProjectPaths(paths, entry.project);
    switch (entry.type) {
      case "architecture":
        return p.architecture;
      case "decision":
        return p.decisions;
      case "task":
      case "action-item":
        return p.tasks;
      case "open-question":
        return p.openQuestions;
      default:
        return p.overview;
    }
  }
  switch (entry.type) {
    case "preference":
      return paths.globalFiles.preferences;
    case "decision":
    case "architecture":
    case "action-item":
    case "task":
    case "open-question":
      return paths.globalFiles.conventions;
    default:
      return paths.globalFiles.profile;
  }
}

/**
 * Close an unterminated code fence, returning the content otherwise untouched.
 *
 * Only a fence opened and never closed matters: readers track the marker that
 * opened the fence, so a mismatched inner marker is already inert.
 */
function balanceFences(content: string): string {
  let open: string | null = null;
  for (const line of content.split("\n")) {
    const m = /^\s*(```|~~~)/.exec(line);
    if (!m) continue;
    if (open === null) open = m[1];
    else if (line.trimStart().startsWith(open)) open = null;
  }
  return open === null ? content : `${content}\n${open}`;
}

/** Heading level `formatAppliedBlock` gives every applied memory. */
const APPLIED_HEADING_LEVEL = 2;

/**
 * Push any heading in applied content below the block's own `## `.
 *
 * `stripSupersededSections` ends a retired section at the next heading of the
 * same or a shallower level, so a `#` or `##` line inside the content ended the
 * block early: retiring that memory removed the text above the line and left
 * everything below it in place, while the reviewer and the agent were both told
 * the memory had been retired. Demoting rather than neutralizing keeps the
 * author's structure — the lines stay headings, nested under the block they
 * were always describing. Fence-aware via the one heading scanner, so a `##`
 * inside a code sample is left exactly as written.
 */
function nestHeadingsUnderBlock(content: string): string {
  const lines = content.split("\n");
  const out = [...lines];
  scanMarkdownLines(lines, (i, line, heading) => {
    if (!heading || heading.level > APPLIED_HEADING_LEVEL) return;
    out[i] = line.replace(/^#+/, "#".repeat(APPLIED_HEADING_LEVEL + 1));
  });
  return out.join("\n");
}

/**
 * Render the Markdown block appended to a memory file when an entry is applied.
 * Distinct from the pending block: it carries no `Status: pending` marker and
 * uses a clean, type-titled heading suitable for a graduated memory file. The
 * content is preserved verbatim; provenance (source + tags) goes in a footer.
 */
export function formatAppliedBlock(entry: PendingEntry): string {
  const lines: string[] = [];
  const typeTitle = entry.type
    .replace(/(^|[-\s])(\w)/g, (_m: string, sep: string, c: string) => (sep ? " " : "") + c.toUpperCase())
    .trim();
  // The heading is the ADDRESS a supersession reference names, so it has to be
  // unique within the file. `timestampLabel` has minute granularity, and a
  // reviewer working through a backlog applies several same-type entries inside
  // one minute routinely — byte-identical headings, and retiring one would
  // retire the other. A short content-derived suffix separates them; two
  // entries that agree on content as well are the same memory, which the inbox
  // dedup already refuses.
  const anchor = fnv1a32(entry.content.trim()).toString(36).padStart(7, "0");
  lines.push(`## ${typeTitle} — ${entry.timestampLabel} · ${anchor}`);
  lines.push("");
  // Fences are balanced before the content is written into a file the plugin
  // later scans. Content is agent-supplied and lands verbatim, and an odd
  // number of fence markers desynchronizes every fence-aware reader from that
  // point to the end of the file — which made one crafted memory able to hide
  // every section after it. Closing the fence is additive and visible; nothing
  // in the content is altered or removed.
  lines.push(nestHeadingsUnderBlock(balanceFences(entry.content.trim())));
  if (entry.relatedPaths.length > 0) {
    lines.push("");
    lines.push("Related files:");
    lines.push("");
    for (const p of entry.relatedPaths) lines.push(`* ${p}`);
  }
  const footer: string[] = [];
  // Informational only — the authoritative record lives in the supersession
  // ledger, which nothing but `applyPending` writes. Parsing this line back
  // would make any applied memory able to retire another just by containing it.
  if (entry.supersedes) footer.push(`supersedes: ${entry.supersedes}`);
  if (entry.source) footer.push(`source: ${entry.source}`);
  footer.push(`tags: ${formatTags(entry.tags)}`);
  lines.push("");
  lines.push(`_Applied from Coder Engram review · ${footer.join(" · ")}_`);
  lines.push("");
  return lines.join("\n");
}
