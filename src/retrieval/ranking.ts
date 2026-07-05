/**
 * ranking — tokenization, filtering, and snippet helpers shared by retrievers.
 */

import { IndexedChunk } from "../indexing/index-manager";
import { RetrievalFilters } from "./retriever";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "was", "were",
  "for", "on", "with", "as", "at", "by", "it", "this", "that", "be", "from",
]);

/** Lowercase, split on non-word chars, drop stopwords and 1-char tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Tokenize a chunk's text, memoized by chunk identity. `IndexManager` keeps the
 * same `IndexedChunk` object for a note whose content is unchanged across
 * reindexes, so BM25 scoring reuses the token array across queries instead of
 * re-tokenizing the whole corpus on every search. The `WeakMap` self-evicts when
 * a chunk object is replaced (content changed) or removed.
 */
const chunkTokenCache = new WeakMap<IndexedChunk, string[]>();
export function tokenizeChunk(chunk: IndexedChunk): string[] {
  let tokens = chunkTokenCache.get(chunk);
  if (!tokens) {
    tokens = tokenize(chunk.text);
    chunkTokenCache.set(chunk, tokens);
  }
  return tokens;
}

function normalizeFolder(folder: string): string {
  return folder.trim().replace(/^\/+|\/+$/g, "");
}

function isUnderFolder(path: string, folder: string): boolean {
  const f = normalizeFolder(folder);
  if (f === "") return true;
  return path === f || path.startsWith(f + "/");
}

/**
 * Apply structural filters to chunks before scoring.
 * `projectRootResolver` maps a project name to its folder (for the `project`
 * filter); omit it if project filtering is not applicable.
 */
export function applyFilters(
  chunks: IndexedChunk[],
  filters: RetrievalFilters | undefined,
  projectRootResolver?: (project: string) => string,
): IndexedChunk[] {
  if (!filters) return chunks;
  // No active filter → return the input array unchanged (same reference), so the
  // whole-vault hot path can memoize corpus stats by identity and skips a copy.
  if (!filters.folder && !filters.tag && !filters.project && filters.sinceMtime === undefined) {
    return chunks;
  }
  return chunks.filter((chunk) => {
    if (filters.folder && !isUnderFolder(chunk.notePath, filters.folder)) return false;
    if (filters.project && projectRootResolver) {
      const projFolder = projectRootResolver(filters.project);
      if (!isUnderFolder(chunk.notePath, projFolder)) return false;
    }
    if (filters.tag) {
      const want = filters.tag.toLowerCase().replace(/^#/, "");
      const has = chunk.tags.some((t) => t.toLowerCase().replace(/^#/, "") === want);
      if (!has) return false;
    }
    if (filters.sinceMtime !== undefined && chunk.mtime < filters.sinceMtime) return false;
    return true;
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A [start, end) span of a term match within a text. */
export interface TermMatch {
  start: number;
  end: number;
}

/**
 * Find case-insensitive, whole-token matches of any `terms` in `text`, in order
 * and non-overlapping. "Whole token" uses the same alphanumeric boundaries as
 * {@link tokenize} (via lookarounds), so a query term `art` matches the word
 * "art" but not the "art" inside "start" — keeping snippet selection and UI
 * highlighting consistent with what BM25 actually scored.
 */
export function findTermMatches(text: string, terms: string[]): TermMatch[] {
  const clean = [...new Set(terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0))];
  if (clean.length === 0) return [];
  const pattern = new RegExp(`(?<![a-z0-9])(?:${clean.map(escapeRegExp).join("|")})(?![a-z0-9])`, "gi");
  const matches: TermMatch[] = [];
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    matches.push({ start, end: start + m[0].length });
  }
  return matches;
}

/**
 * Build a plain-text snippet. Rather than centering on the first match, it picks
 * the `window`-sized slice that covers the MOST query-term matches (densest
 * context), anchoring so a match sits ~1/3 in; ties go to the earliest window.
 * Falls back to the head of the text when nothing matches.
 */
export function buildSnippet(text: string, queryTerms: string[], window = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= window) return flat;

  const matches = findTermMatches(flat, queryTerms);
  if (matches.length === 0) return flat.slice(0, window).trimEnd() + "…";

  const lead = Math.floor(window / 3);
  let bestStart = 0;
  let bestCount = -1;
  for (const m of matches) {
    const start = Math.max(0, Math.min(m.start - lead, flat.length - window));
    const end = start + window;
    let count = 0;
    for (const x of matches) if (x.start >= start && x.end <= end) count++;
    if (count > bestCount) {
      bestCount = count;
      bestStart = start;
    }
  }
  const end = Math.min(flat.length, bestStart + window);
  const prefix = bestStart > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  return prefix + flat.slice(bestStart, end).trim() + suffix;
}

/** Per-note cap for a result page of `limit` (default `ceil(limit/3)`, floor 2). */
export function maxPerNoteFor(limit: number): number {
  return Math.max(2, Math.ceil(limit / 3));
}

/**
 * Limit how many chunks any single note contributes to a result page, so one
 * long note can't flood the top results and bury other relevant notes. Walks the
 * already-ranked list in order, admitting a chunk only while its note is under
 * `maxPerNote`; over-cap chunks are deferred and backfill the page (still in rank
 * order) if the cap would otherwise leave it short of `limit`. The page is never
 * smaller than a plain `slice(0, limit)` would produce — a query matching only
 * one note still fills up from that note.
 */
export function diversifyByNote<T extends { chunk: IndexedChunk }>(
  ranked: T[],
  limit: number,
  maxPerNote: number = maxPerNoteFor(limit),
): T[] {
  if (limit <= 0) return [];
  const perNote = new Map<string, number>();
  const selected: T[] = [];
  const deferred: T[] = [];
  for (const item of ranked) {
    if (selected.length >= limit) break;
    const count = perNote.get(item.chunk.notePath) ?? 0;
    if (count < maxPerNote) {
      perNote.set(item.chunk.notePath, count + 1);
      selected.push(item);
    } else {
      deferred.push(item);
    }
  }
  for (const item of deferred) {
    if (selected.length >= limit) break;
    selected.push(item);
  }
  return selected;
}

/** Jaccard similarity of two token sets: |A∩B| / |A∪B|, in [0, 1]. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Token-set Jaccard at/above which two chunks are treated as the same memory.
 * Tuned so "same content, different surrounding context" (e.g. a decision copied
 * into a session note — differing headings/adjacent lines push identical prose to
 * ~0.82) is caught, while genuinely distinct memories (which rarely share >80% of
 * their tokens) are kept. */
const NEAR_DUP_THRESHOLD = 0.8;

/**
 * Drop near-duplicate results, keeping the highest-ranked copy. Two results are
 * near-duplicates when their chunk token sets overlap by at least `threshold`
 * (Jaccard). This is recall-SAFE: the dropped content still appears in the kept,
 * higher-ranked result — it only removes redundant copies (e.g. a decision that
 * was applied into a session note, or overlapping chunk windows) that would
 * otherwise cost tokens without adding information. Input order is preserved.
 */
export function dropNearDuplicates<T extends { chunk: IndexedChunk }>(
  results: T[],
  threshold = NEAR_DUP_THRESHOLD,
): T[] {
  const kept: T[] = [];
  const keptTokens: Set<string>[] = [];
  for (const r of results) {
    const tokens = new Set(tokenizeChunk(r.chunk));
    if (tokens.size > 0 && keptTokens.some((s) => jaccard(s, tokens) >= threshold)) continue;
    kept.push(r);
    keptTokens.push(tokens);
  }
  return kept;
}
