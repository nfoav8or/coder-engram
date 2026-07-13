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

  it("memoizes corpus stats yet reflects a replaced chunk set (no stale cache)", () => {
    const retriever = new LexicalRetriever();
    const first: IndexedChunk[] = [
      chunk({ id: "a", notePath: "Notes/a.md", text: "indexing pipeline for markdown notes" }),
    ];
    const r1 = retriever.retrieve({ query: "indexing" }, first);
    expect(r1[0].chunk.notePath).toBe("Notes/a.md");
    // A repeat query over the SAME array reuses the memo and is identical.
    expect(retriever.retrieve({ query: "indexing" }, first)[0].chunk.id).toBe("a");
    // A NEW array (as IndexManager produces on refresh) must invalidate the memo.
    const second: IndexedChunk[] = [
      chunk({ id: "z", notePath: "Notes/z.md", text: "indexing rewritten in a different note" }),
    ];
    const r2 = retriever.retrieve({ query: "indexing" }, second);
    expect(r2.map((r) => r.chunk.id)).toEqual(["z"]);
  });

  it("repeated same-filter queries reuse cached subset stats without changing results", () => {
    const c: IndexedChunk[] = [
      chunk({ id: "o1", notePath: "One/a.md", text: "indexing pipeline in folder one" }),
      chunk({ id: "o2", notePath: "One/b.md", text: "another indexing note in folder one" }),
      chunk({ id: "t1", notePath: "Two/c.md", text: "indexing note in folder two" }),
    ];
    const retriever = new LexicalRetriever();
    const r1 = retriever.retrieve({ query: "indexing", filters: { folder: "One" } }, c);
    const r2 = retriever.retrieve({ query: "indexing", filters: { folder: "One" } }, c); // cache hit
    expect(r2.map((r) => [r.chunk.id, r.score])).toEqual(r1.map((r) => [r.chunk.id, r.score]));
    expect(r1.map((r) => r.chunk.notePath).every((p) => p.startsWith("One/"))).toBe(true);
    // A different filter must not reuse the cached subset.
    const r3 = retriever.retrieve({ query: "indexing", filters: { folder: "Two" } }, c);
    expect(r3.map((r) => r.chunk.id)).toEqual(["t1"]);
  });

  it("ranks a note whose FILENAME matches the query even when its body doesn't", () => {
    const c: IndexedChunk[] = [
      chunk({ id: "f", notePath: "Ref/Quartzine Protocol.md", text: "generic body words only here" }),
      chunk({ id: "o", notePath: "Notes/other.md", text: "more generic body words here" }),
    ];
    const results = lexicalSearch("quartzine protocol", c);
    expect(results.map((r) => r.chunk.id)).toEqual(["f"]);
    expect(results[0].matchedTerms).toEqual(["quartzine", "protocol"]);
  });

  it("ranks a note whose frontmatter ALIAS matches the query", () => {
    const c: IndexedChunk[] = [
      chunk({ id: "a1", notePath: "Areas/area.md", aliases: ["bramblewood"], text: "generic body words only" }),
      chunk({ id: "o1", notePath: "Notes/other.md", text: "more generic body words" }),
    ];
    const results = lexicalSearch("bramblewood", c);
    expect(results.map((r) => r.chunk.id)).toEqual(["a1"]);
  });

  it("does not credit the file extension as a filename field term", () => {
    // "pdf" appears in no body, so as a field term it would carry max IDF and
    // every chunk of every PDF would drown genuine body matches for a query
    // that happens to contain the word "pdf".
    const c: IndexedChunk[] = [
      chunk({ id: "att", notePath: "Papers/report.pdf", text: "generic body words only here" }),
      chunk({ id: "body", notePath: "Notes/n.md", text: "exporting a pdf invoice summary" }),
    ];
    const results = lexicalSearch("pdf invoice", c);
    expect(results.map((r) => r.chunk.id)).toEqual(["body"]);
    // The extension-less basename still field-matches.
    expect(lexicalSearch("report", c).map((r) => r.chunk.id)).toEqual(["att"]);
  });

  it("a strong body match outranks a field-only match; both still surface", () => {
    // Field credit is calibrated to ONE average-length-body occurrence, so a
    // repeated body term must win. (A field-only match MAY outrank a single
    // mention buried in a very long chunk — that is deliberate.)
    const c: IndexedChunk[] = [
      chunk({ id: "body", notePath: "Notes/a.md", text: "the quartzine threshold is nine and quartzine applies" }),
      chunk({ id: "name", notePath: "Ref/Quartzine.md", text: "generic body words only here" }),
    ];
    const results = lexicalSearch("quartzine", c);
    expect(results[0].chunk.id).toBe("body");
    expect(results.map((r) => r.chunk.id)).toContain("name");
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
