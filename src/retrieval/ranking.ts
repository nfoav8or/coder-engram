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
