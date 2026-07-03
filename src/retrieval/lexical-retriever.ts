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
import { tokenize, applyFilters, buildSnippet } from "./ranking";

const K1 = 1.5;
const B = 0.75;
const HEADING_BOOST = 1.15;

export interface LexicalRetrieverOptions {
  projectRootResolver?: (project: string) => string;
}

export class LexicalRetriever implements Retriever {
  readonly mode = "lexical";

  constructor(private readonly options: LexicalRetrieverOptions = {}) {}

  retrieve(query: RetrievalQuery, chunks: IndexedChunk[]): RetrievalResult[] {
    const queryTerms = tokenize(query.query);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const filtered = applyFilters(chunks, query.filters, this.options.projectRootResolver);
    if (queryTerms.length === 0 || filtered.length === 0) return [];

    // Precompute tokenized docs, lengths, and document frequencies.
    const docs = filtered.map((chunk) => tokenize(chunk.text));
    const docLengths = docs.map((d) => d.length);
    const avgdl = docLengths.reduce((a, b) => a + b, 0) / (docs.length || 1);

    const df = new Map<string, number>();
    for (const doc of docs) {
      for (const term of new Set(doc)) {
        df.set(term, (df.get(term) ?? 0) + 1);
      }
    }

    const N = docs.length;
    const uniqueQueryTerms = Array.from(new Set(queryTerms));

    const scored: RetrievalResult[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const doc = docs[i];
      if (doc.length === 0) continue;
      const tf = new Map<string, number>();
      for (const term of doc) tf.set(term, (tf.get(term) ?? 0) + 1);

      const headingTerms = new Set(tokenize(filtered[i].heading));
      let score = 0;
      const matched: string[] = [];
      for (const term of uniqueQueryTerms) {
        const f = tf.get(term);
        if (!f) continue;
        matched.push(term);
        const n = df.get(term) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        const denom = f + K1 * (1 - B + (B * docLengths[i]) / avgdl);
        let termScore = (idf * (f * (K1 + 1))) / denom;
        if (headingTerms.has(term)) termScore *= HEADING_BOOST;
        score += termScore;
      }

      if (score > 0) {
        scored.push({
          chunk: filtered[i],
          score,
          snippet: buildSnippet(filtered[i].text, uniqueQueryTerms),
          matchedTerms: matched,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
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
