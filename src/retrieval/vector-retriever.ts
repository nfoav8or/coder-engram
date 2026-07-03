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
import { tokenize, applyFilters, buildSnippet } from "./ranking";

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
    const scored: RetrievalResult[] = [];
    for (const chunk of filtered) {
      const vec = this.options.vectors.get(chunk.id);
      if (!vec) continue;
      const score = cosineSimilarity(qv, vec);
      if (score <= 0) continue;
      const chunkTerms = new Set(tokenize(chunk.text));
      scored.push({
        chunk,
        score,
        snippet: buildSnippet(chunk.text, queryTerms),
        matchedTerms: queryTerms.filter((t) => chunkTerms.has(t)),
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
