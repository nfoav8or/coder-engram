import { describe, it, expect } from "vitest";
import { HybridRetriever } from "../src/retrieval/hybrid-retriever";
import { LexicalRetriever } from "../src/retrieval/lexical-retriever";
import { IndexedChunk } from "../src/indexing/index-manager";
import type { VectorEntry } from "../src/embeddings/embedding-provider";
import { vectorNorm } from "../src/embeddings/embedding-provider";

const entry = (v: number[]): VectorEntry => ({ vec: new Float32Array(v), norm: vectorNorm(v) });

function chunk(partial: Partial<IndexedChunk> & { id: string; text: string }): IndexedChunk {
  return {
    notePath: partial.notePath ?? `${partial.id}.md`,
    heading: partial.heading ?? "",
    headingPath: partial.headingPath ?? [],
    startLine: 0,
    endLine: 0,
    tags: partial.tags ?? [],
    aliases: [],
    links: [],
    symbols: [],
    mtime: partial.mtime ?? 1000,
    ...partial,
  };
}

const corpus: IndexedChunk[] = [
  chunk({ id: "a", notePath: "Notes/a.md", text: "apple apple apple orchard fruit" }),
  chunk({ id: "b", notePath: "Notes/b.md", text: "cherry blossom tree garden" }),
  chunk({ id: "c", notePath: "Notes/c.md", text: "apple pie recipe" }),
];

// Vector map: b is strongly aligned with the query vector below; a and c are
// orthogonal to it (cosine 0 => excluded from the vector side).
const vectors = new Map<string, VectorEntry>([
  ["a", entry([1, 0, 0])],
  ["b", entry([0, 1, 0])],
  ["c", entry([1, 0, 0])],
]);

describe("HybridRetriever", () => {
  it("has hybrid mode", () => {
    expect(new HybridRetriever({ vectors }).mode).toBe("hybrid");
  });

  it("equals the lexical ranking when there is no query vector (degradation)", () => {
    const hybrid = new HybridRetriever({ vectors });
    const lexical = new LexicalRetriever();
    const query = { query: "apple" };
    const hybridIds = hybrid.retrieve(query, corpus).map((r) => r.chunk.id);
    const lexicalIds = lexical.retrieve(query, corpus).map((r) => r.chunk.id);
    expect(hybridIds).toEqual(lexicalIds);
  });

  it("surfaces a chunk the vector side favors but lexical ignores", () => {
    const hybrid = new HybridRetriever({ vectors });
    const lexical = new LexicalRetriever();
    // "apple" matches a and c lexically, not b. The query vector aligns with b.
    const query = { query: "apple", queryVector: [0, 1, 0] };

    const lexicalIds = lexical.retrieve(query, corpus).map((r) => r.chunk.id);
    expect(lexicalIds).not.toContain("b");

    const hybridIds = hybrid.retrieve(query, corpus).map((r) => r.chunk.id);
    expect(hybridIds).toContain("b");
  });

  it("produces small positive RRF scores sorted descending, within the limit", () => {
    const hybrid = new HybridRetriever({ vectors });
    const results = hybrid.retrieve({ query: "apple", queryVector: [0, 1, 0], limit: 5 }, corpus);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThan(1);
    }
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });
});
