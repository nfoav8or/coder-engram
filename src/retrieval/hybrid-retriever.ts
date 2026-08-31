/**
 * HybridRetriever — fuses lexical (BM25) and vector (cosine) rankings via
 * Reciprocal Rank Fusion (RRF).
 *
 * RRF combines by RANK, not raw score, so the incomparable scales of BM25 and
 * cosine never need normalizing: each list contributes 1/(k + rank) per chunk.
 * We pull a deeper candidate list from each sub-retriever than the final limit
 * so a chunk ranked well by only one method can still surface.
 *
 * Degradation: if the vector side returns nothing (no query vector / provider
 * down / no embeddings yet), the fused ranking equals the lexical ranking — the
 * plugin never fails closed.
 */

import { IndexedChunk } from "../indexing/index-manager";
import type { VectorEntry } from "../embeddings/embedding-provider";
import {
  Retriever,
  RetrievalQuery,
  RetrievalResult,
  DEFAULT_LIMIT,
} from "./retriever";
import { LexicalRetriever } from "./lexical-retriever";
import { VectorRetriever } from "./vector-retriever";
import { candidateDepthFor, diversifyByNote, fuseByRank } from "./ranking";


export interface HybridRetrieverOptions {
  vectors: Map<string, VectorEntry>;
  projectRootResolver?: (project: string) => string;
}

export class HybridRetriever implements Retriever {
  readonly mode = "hybrid";
  private readonly lexical: LexicalRetriever;
  private readonly vector: VectorRetriever;

  constructor(options: HybridRetrieverOptions) {
    this.lexical = new LexicalRetriever({ projectRootResolver: options.projectRootResolver });
    this.vector = new VectorRetriever({
      vectors: options.vectors,
      projectRootResolver: options.projectRootResolver,
    });
  }

  retrieve(query: RetrievalQuery, chunks: IndexedChunk[]): RetrievalResult[] {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const candidates = candidateDepthFor(limit);
    const deepQuery: RetrievalQuery = { ...query, limit: candidates };

    const lexResults = this.lexical.retrieve(deepQuery, chunks);
    const vecResults = this.vector.retrieve(deepQuery, chunks);

    // Fuse by rank via the shared helper. Vector first, then lexical with
    // preferPayload, so the lexical payload wins when a chunk is in both — its
    // matchedTerms are what drive highlighting.
    const fused = fuseByRank([
      { results: vecResults, preferPayload: false },
      { results: lexResults, preferPayload: true },
    ]);

    // Diversify the fused ranking so one long note can't flood the page. This is
    // the binding pass for hybrid mode: the sub-retrievers diversify their deep
    // candidate lists too, but at a loose cap (scaled to `candidates`), so this
    // final cap on the fused order is what the user sees.
    const ranked = fused.map((entry) => ({ ...entry.result, score: entry.score }));
    return diversifyByNote(ranked, limit);
  }
}
