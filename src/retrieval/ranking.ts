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

/**
 * Build a plain-text snippet centered on the first query-term match.
 * Returns up to `window` characters. Falls back to the head of the text.
 */
export function buildSnippet(text: string, queryTerms: string[], window = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= window) return flat;

  const lower = flat.toLowerCase();
  let matchIdx = -1;
  for (const term of queryTerms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (matchIdx === -1 || idx < matchIdx)) matchIdx = idx;
  }
  if (matchIdx === -1) return flat.slice(0, window).trimEnd() + "…";

  const start = Math.max(0, matchIdx - Math.floor(window / 3));
  const end = Math.min(flat.length, start + window);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  return prefix + flat.slice(start, end).trim() + suffix;
}
