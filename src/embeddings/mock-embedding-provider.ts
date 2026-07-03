/**
 * MockEmbeddingProvider — deterministic hash-based embeddings.
 *
 * Produces stable pseudo-vectors from text with zero dependencies or network.
 * Useful for development, tests, and exercising the vector storage path before
 * a real provider is configured. NOT semantically meaningful — do not use for
 * production retrieval quality.
 */

import { EmbeddingProvider } from "./embedding-provider";

const DEFAULT_DIM = 64;

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

/** Simple deterministic string hash (FNV-1a style). */
function hash(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly id = "mock";
  readonly model = "mock-hash";
  readonly dimensions: number;

  constructor(dimensions = DEFAULT_DIM) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    const tokens = tokenize(text);
    for (const token of tokens) {
      const h = hash(token);
      const idx = h % this.dimensions;
      const sign = (h & 1) === 0 ? 1 : -1;
      vec[idx] += sign;
    }
    // L2 normalize so cosine similarity is well-behaved.
    const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0));
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
