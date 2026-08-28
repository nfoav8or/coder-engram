/**
 * VectorRetriever — ranks chunks by cosine similarity between the (pre-computed)
 * query vector and each chunk's stored embedding.
 *
 * It holds a chunkId -> {vector, norm} map supplied by the engine (decoded from
 * EmbeddingStore). `retrieve` is synchronous: the async query embedding is done
 * upstream and arrives as `query.queryVector`. With no query vector (provider
 * down, or not yet embedded) it returns nothing, so hybrid retrieval degrades
 * cleanly to lexical.
 */

import { IndexedChunk } from "../indexing/index-manager";
import { VectorEntry, vectorNorm } from "../embeddings/embedding-provider";
import {
  Retriever,
  RetrievalQuery,
  RetrievalResult,
  DEFAULT_LIMIT,
} from "./retriever";
import { tokenize, tokenizeChunk, applyFilters, buildSnippet, diversifyByNote } from "./ranking";

export interface VectorRetrieverOptions {
  vectors: Map<string, VectorEntry>;
  projectRootResolver?: (project: string) => string;
}

export class VectorRetriever implements Retriever {
  readonly mode = "vector";

  constructor(private readonly options: VectorRetrieverOptions) {}

  retrieve(query: RetrievalQuery, chunks: IndexedChunk[]): RetrievalResult[] {
    const qv = query.queryVector;
    if (!qv || qv.length === 0 || this.options.vectors.size === 0) return [];

    const limit = query.limit ?? DEFAULT_LIMIT;
    const filtered = applyFilters(chunks, query.filters, this.options.projectRootResolver);
    if (filtered.length === 0) return [];

    const queryTerms = Array.from(new Set(tokenize(query.query)));
    // Same math as cosineSimilarity with both norms hoisted: the query's is
    // computed once per call, each stored vector's is computed once per decode
    // in `EmbeddingStore.entriesMap` — the per-candidate work is the dot
    // product.
    //
    // Both norm guards are `> 0` rather than `!== 0` so a NaN norm exits here
    // too. A NaN score does not survive `score <= 0` (every comparison against
    // NaN is false), so it would sort into results at an arbitrary rank.
    const qNorm = vectorNorm(qv);
    if (!(qNorm > 0)) return [];
    const scored: Array<{ chunk: IndexedChunk; score: number }> = [];
    for (const chunk of filtered) {
      const entry = this.options.vectors.get(chunk.id);
      if (!entry || entry.vec.length !== qv.length || !(entry.norm > 0)) continue;
      const vec = entry.vec;
      let dot = 0;
      for (let i = 0; i < qv.length; i++) dot += qv[i] * vec[i];
      const score = dot / (qNorm * entry.norm);
      if (score <= 0) continue;
      scored.push({ chunk, score });
    }

    // Rank, then diversify so a single long note can't flood the page. Snippet
    // and matched-term work is deferred to the survivors: tokenizing every scored
    // chunk's text just to compute highlighting for results that get dropped is
    // wasted (cosine scores nearly every chunk > 0).
    scored.sort((a, b) => b.score - a.score);
    return diversifyByNote(scored, limit).map((s) => {
      const chunkTerms = new Set(tokenizeChunk(s.chunk));
      return {
        chunk: s.chunk,
        score: s.score,
        snippet: buildSnippet(s.chunk.text, queryTerms),
        matchedTerms: queryTerms.filter((t) => chunkTerms.has(t)),
      };
    });
  }
}
