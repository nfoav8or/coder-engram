/**
 * VectorRetriever — ranks chunks by cosine similarity between the (pre-computed)
 * query vector and each chunk's stored embedding.
 *
 * It holds a chunkId -> vector map supplied by the engine (loaded from
 * EmbeddingStore). `retrieve` is synchronous: the async query embedding is done
 * upstream and arrives as `query.queryVector`. With no query vector (provider
 * down, or not yet embedded) it returns nothing, so hybrid retrieval degrades
 * cleanly to lexical.
 */

import { IndexedChunk } from "../indexing/index-manager";
import { cosineSimilarity } from "../embeddings/embedding-provider";
import {
  Retriever,
  RetrievalQuery,
  RetrievalResult,
  DEFAULT_LIMIT,
} from "./retriever";
import { tokenize, tokenizeChunk, applyFilters, buildSnippet, diversifyByNote } from "./ranking";

export interface VectorRetrieverOptions {
  vectors: Map<string, number[]>;
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
    const scored: Array<{ chunk: IndexedChunk; score: number }> = [];
    for (const chunk of filtered) {
      const vec = this.options.vectors.get(chunk.id);
      if (!vec) continue;
      const score = cosineSimilarity(qv, vec);
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
