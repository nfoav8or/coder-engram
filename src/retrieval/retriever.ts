/**
 * Retriever interface + shared types.
 *
 * A Retriever ranks index chunks against a query. M1 ships a lexical (BM25)
 * retriever; a vector retriever slots in at M3 behind this same interface, so
 * callers (UI, server tools) never change.
 */

import { IndexedChunk } from "../indexing/index-manager";

export interface RetrievalFilters {
  /** Restrict to notes under this folder (vault-relative). */
  folder?: string;
  /** Restrict to notes carrying this tag (without leading `#`). */
  tag?: string;
  /** Restrict to a project folder under the projects root. */
  project?: string;
  /** Only include chunks whose note mtime is >= this (ms epoch). */
  sinceMtime?: number;
}

export interface RetrievalQuery {
  query: string;
  limit?: number;
  filters?: RetrievalFilters;
}

export interface RetrievalResult {
  chunk: IndexedChunk;
  score: number;
  /** Plain-text snippet window around the best match. */
  snippet: string;
  /** Query terms that matched (lowercased), for highlighting. */
  matchedTerms: string[];
}

export interface Retriever {
  readonly mode: string;
  retrieve(query: RetrievalQuery, chunks: IndexedChunk[]): RetrievalResult[];
}

export const DEFAULT_LIMIT = 8;
