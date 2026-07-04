import { describe, it, expect } from "vitest";
import { LexicalRetriever, lexicalSearch } from "../src/retrieval/lexical-retriever";
import { IndexedChunk } from "../src/indexing/index-manager";

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
  chunk({ id: "a", notePath: "Notes/a.md", text: "The vault indexing pipeline chunks markdown notes for retrieval." }),
  chunk({ id: "b", notePath: "Notes/b.md", text: "Embedding providers include Ollama and OpenAI compatible backends." }),
  chunk({ id: "c", notePath: "Projects/x/decisions.md", heading: "Indexing decision", tags: ["decision"], text: "We decided to use a local JSON index for indexing performance.", mtime: 5000 }),
];

describe("LexicalRetriever", () => {
  it("ranks the most relevant chunk first", () => {
    const results = new LexicalRetriever().retrieve({ query: "indexing markdown" }, corpus);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.notePath).toBe("Notes/a.md");
  });

  it("returns matched terms and a snippet", () => {
    const results = lexicalSearch("Ollama embedding", corpus);
    expect(results[0].chunk.notePath).toBe("Notes/b.md");
    expect(results[0].matchedTerms).toEqual(expect.arrayContaining(["ollama"]));
    expect(results[0].snippet.toLowerCase()).toContain("ollama");
  });

  it("returns nothing for an empty query", () => {
    expect(lexicalSearch("", corpus)).toEqual([]);
  });

  it("returns nothing when no term matches", () => {
    expect(lexicalSearch("xyzzy nonexistent", corpus)).toEqual([]);
  });

  it("respects a folder filter", () => {
    const results = lexicalSearch("indexing", corpus, { filters: { folder: "Projects" } });
    expect(results.every((r) => r.chunk.notePath.startsWith("Projects/"))).toBe(true);
  });

  it("respects a tag filter", () => {
    const results = lexicalSearch("indexing", corpus, { filters: { tag: "decision" } });
    expect(results.length).toBe(1);
    expect(results[0].chunk.notePath).toBe("Projects/x/decisions.md");
  });

  it("respects a recency filter", () => {
    const results = lexicalSearch("indexing", corpus, { filters: { sinceMtime: 4000 } });
    expect(results.every((r) => r.chunk.mtime >= 4000)).toBe(true);
  });

  it("honors the limit", () => {
    const results = lexicalSearch("indexing", corpus, { limit: 1 });
    expect(results.length).toBe(1);
  });

  it("does not let one long note flood the page and bury another relevant note", () => {
    const flooded: IndexedChunk[] = [
      chunk({ id: "a1", notePath: "Notes/long.md", text: "indexing pipeline detail one" }),
      chunk({ id: "a2", notePath: "Notes/long.md", text: "indexing pipeline detail two" }),
      chunk({ id: "a3", notePath: "Notes/long.md", text: "indexing pipeline detail three" }),
      chunk({ id: "a4", notePath: "Notes/long.md", text: "indexing pipeline detail four" }),
      chunk({ id: "a5", notePath: "Notes/long.md", text: "indexing pipeline detail five" }),
      chunk({ id: "b1", notePath: "Notes/other.md", text: "indexing is also discussed here" }),
    ];
    const results = lexicalSearch("indexing", flooded, { limit: 4 });
    const notes = results.map((r) => r.chunk.notePath);
    // The other note must surface rather than being buried under long.md's chunks,
    // and long.md must not occupy every slot.
    expect(notes).toContain("Notes/other.md");
    expect(notes.filter((n) => n === "Notes/long.md").length).toBeLessThan(4);
    // The page is still filled to the requested limit (backfill from the surplus).
    expect(results.length).toBe(4);
  });
});
