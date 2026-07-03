/**
 * EmbeddingProvider — abstraction over embedding backends.
 *
 * M1 ships only the interface and a deterministic mock provider so the vector
 * storage model and retrieval interfaces can be exercised without any network
 * or API key. Ollama and OpenAI-compatible providers arrive in M3 behind this
 * same interface. The plugin must always function with NO provider (lexical
 * retrieval), so nothing here is on the critical path.
 */

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  /** Embed a batch of texts. Order of output matches order of input. */
  embed(texts: string[]): Promise<number[][]>;
  /** Cheap liveness check; providers that need a network return false on failure. */
  isAvailable(): Promise<boolean>;
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
