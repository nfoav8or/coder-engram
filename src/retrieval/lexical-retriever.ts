/**
 * lexical-retriever — BM25 ranking over index chunks. No API keys, works
 * offline, and is the default retrieval mode for M1.
 *
 * BM25 is computed over the (already filtered) candidate set so that IDF
 * reflects the corpus the user is actually searching. A small heading-match
 * boost nudges chunks whose heading contains a query term.
 */

import { IndexedChunk } from "../indexing/index-manager";
import {
  Retriever,
  RetrievalQuery,
  RetrievalResult,
  RetrievalFilters,
  DEFAULT_LIMIT,
} from "./retriever";
import { tokenize, tokenizeChunk, applyFilters, buildSnippet, diversifyByNote } from "./ranking";

const K1 = 1.5;
const B = 0.75;
const HEADING_BOOST = 1.15;

export interface LexicalRetrieverOptions {
  projectRootResolver?: (project: string) => string;
}

/**
 * Corpus-invariant BM25 statistics for one chunk set: per-chunk term frequencies,
 * document lengths, per-chunk heading terms, and the global document-frequency map
 * + average doc length. These depend only on the chunks, not the query, so they
 * are computed once per corpus and reused across queries.
 */
interface CorpusStats {
  chunks: IndexedChunk[];
  tf: Map<string, number>[];
  headingTerms: Set<string>[];
  docLengths: number[];
  df: Map<string, number>;
  avgdl: number;
  N: number;
}

function buildStats(chunks: IndexedChunk[]): CorpusStats {
  const tf: Map<string, number>[] = [];
  const headingTerms: Set<string>[] = [];
  const docLengths: number[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const chunk of chunks) {
    const doc = tokenizeChunk(chunk); // memoized by chunk identity
    const counts = new Map<string, number>();
    for (const term of doc) counts.set(term, (counts.get(term) ?? 0) + 1);
    tf.push(counts);
    docLengths.push(doc.length);
    totalLen += doc.length;
    for (const term of counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    headingTerms.push(new Set(tokenize(chunk.heading)));
  }
  return { chunks, tf, headingTerms, docLengths, df, avgdl: totalLen / (chunks.length || 1), N: chunks.length };
}

export class LexicalRetriever implements Retriever {
  readonly mode = "lexical";
  /** Memoized whole-corpus stats, keyed by the chunks array identity (which
   * IndexManager replaces on refresh), so repeated queries over an unchanged
   * vault reuse them instead of rebuilding tf/df from scratch each time. */
  private cached: CorpusStats | null = null;

  constructor(private readonly options: LexicalRetrieverOptions = {}) {}

  private statsFor(chunks: IndexedChunk[], filtered: IndexedChunk[]): CorpusStats {
    // Whole-vault search (the hot path): stats over `filtered` equal stats over
    // `chunks`, so memoize by identity. A filtered subset gets fresh stats so IDF
    // reflects exactly the searched set (unchanged from the per-query behavior).
    if (filtered !== chunks) return buildStats(filtered);
    if (!this.cached || this.cached.chunks !== chunks) this.cached = buildStats(chunks);
    return this.cached;
  }

  retrieve(query: RetrievalQuery, chunks: IndexedChunk[]): RetrievalResult[] {
    const queryTerms = tokenize(query.query);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const filtered = applyFilters(chunks, query.filters, this.options.projectRootResolver);
    if (queryTerms.length === 0 || filtered.length === 0) return [];

    const stats = this.statsFor(chunks, filtered);
    const uniqueQueryTerms = Array.from(new Set(queryTerms));

    const scored: Array<{ chunk: IndexedChunk; score: number; matched: string[] }> = [];
    for (let i = 0; i < filtered.length; i++) {
      if (stats.docLengths[i] === 0) continue;
      const tf = stats.tf[i];
      let score = 0;
      const matched: string[] = [];
      for (const term of uniqueQueryTerms) {
        const f = tf.get(term);
        if (!f) continue;
        matched.push(term);
        const n = stats.df.get(term) ?? 0;
        const idf = Math.log(1 + (stats.N - n + 0.5) / (n + 0.5));
        const denom = f + K1 * (1 - B + (B * stats.docLengths[i]) / stats.avgdl);
        let termScore = (idf * (f * (K1 + 1))) / denom;
        if (stats.headingTerms[i].has(term)) termScore *= HEADING_BOOST;
        score += termScore;
      }

      if (score > 0) scored.push({ chunk: filtered[i], score, matched });
    }

    // Rank, diversify so a single long note can't flood the page, then build
    // snippets only for the survivors — snippet text has no effect on score or
    // ordering, so building it for every scoring chunk is wasted work.
    scored.sort((a, b) => b.score - a.score);
    return diversifyByNote(scored, limit).map((s) => ({
      chunk: s.chunk,
      score: s.score,
      snippet: buildSnippet(s.chunk.text, uniqueQueryTerms),
      matchedTerms: s.matched,
    }));
  }
}

/** Convenience helper for callers that just want ranked results from an index. */
export function lexicalSearch(
  queryText: string,
  chunks: IndexedChunk[],
  opts: { limit?: number; filters?: RetrievalFilters; projectRootResolver?: (p: string) => string } = {},
): RetrievalResult[] {
  const retriever = new LexicalRetriever({ projectRootResolver: opts.projectRootResolver });
  return retriever.retrieve({ query: queryText, limit: opts.limit, filters: opts.filters }, chunks);
}
