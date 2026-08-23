import { describe, it, expect } from "vitest";
import { VectorRetriever } from "../src/retrieval/vector-retriever";
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
    mtime: partial.mtime ?? 1000,
    ...partial,
  };
}

const corpus: IndexedChunk[] = [
  chunk({ id: "a", notePath: "Notes/a.md", text: "alpha vector content" }),
  chunk({ id: "b", notePath: "Notes/b.md", text: "beta vector content" }),
  chunk({ id: "c", notePath: "Projects/x/c.md", tags: ["decision"], text: "gamma vector content" }),
];

const vectors = new Map<string, VectorEntry>([
  ["a", entry([1, 0, 0])],
  ["b", entry([0, 1, 0])],
  ["c", entry([0, 0, 1])],
]);

describe("VectorRetriever", () => {
  it("has vector mode", () => {
    expect(new VectorRetriever({ vectors }).mode).toBe("vector");
  });

  it("returns [] when the query vector is missing", () => {
    const r = new VectorRetriever({ vectors });
    expect(r.retrieve({ query: "x" }, corpus)).toEqual([]);
  });

  it("returns [] when the query vector is empty", () => {
    const r = new VectorRetriever({ vectors });
    expect(r.retrieve({ query: "x", queryVector: [] }, corpus)).toEqual([]);
  });

  it("returns [] when the vectors map is empty", () => {
    const r = new VectorRetriever({ vectors: new Map() });
    expect(r.retrieve({ query: "x", queryVector: [1, 0, 0] }, corpus)).toEqual([]);
  });

  it("ranks the chunk closest to the query vector first", () => {
    const r = new VectorRetriever({ vectors });
    const results = r.retrieve({ query: "alpha", queryVector: [0.9, 0.1, 0] }, corpus);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.id).toBe("a");
  });

  it("skips chunks that have no stored vector", () => {
    const r = new VectorRetriever({ vectors });
    const withUnvectored = [...corpus, chunk({ id: "d", notePath: "Notes/d.md", text: "delta" })];
    const results = r.retrieve({ query: "x", queryVector: [1, 0, 0] }, withUnvectored);
    expect(results.some((res) => res.chunk.id === "d")).toBe(false);
  });

  it("applies a folder filter", () => {
    const r = new VectorRetriever({ vectors });
    const results = r.retrieve(
      { query: "gamma", queryVector: [0, 0, 1], filters: { folder: "Projects" } },
      corpus,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((res) => res.chunk.notePath.startsWith("Projects/"))).toBe(true);
  });

  it("applies a tag filter", () => {
    const r = new VectorRetriever({ vectors });
    const results = r.retrieve(
      { query: "gamma", queryVector: [0, 0, 1], filters: { tag: "decision" } },
      corpus,
    );
    expect(results.length).toBe(1);
    expect(results[0].chunk.id).toBe("c");
  });

  it("honors the limit", () => {
    const r = new VectorRetriever({ vectors });
    const results = r.retrieve({ query: "x", queryVector: [1, 1, 1], limit: 1 }, corpus);
    expect(results.length).toBe(1);
  });
});
