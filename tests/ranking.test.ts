import { describe, it, expect } from "vitest";
import {
  findTermMatches,
  buildSnippet,
  tokenize,
  tokenizeChunk,
  diversifyByNote,
  maxPerNoteFor,
} from "../src/retrieval/ranking";
import { IndexedChunk } from "../src/indexing/index-manager";

describe("findTermMatches", () => {
  it("matches whole tokens case-insensitively", () => {
    const m = findTermMatches("The OLLAMA server", ["ollama"]);
    expect(m).toHaveLength(1);
    expect("The OLLAMA server".slice(m[0].start, m[0].end)).toBe("OLLAMA");
  });

  it("does not match a term inside a larger word", () => {
    // "art" appears inside "restart" but only the standalone word should match.
    const m = findTermMatches("restart art", ["art"]);
    expect(m).toHaveLength(1);
    expect(m[0].start).toBe(8);
    expect("restart art".slice(m[0].start, m[0].end)).toBe("art");
  });

  it("returns every occurrence in order, non-overlapping", () => {
    const m = findTermMatches("cat dog cat", ["cat"]);
    expect(m).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
  });

  it("returns nothing for empty terms", () => {
    expect(findTermMatches("hello world", [])).toEqual([]);
    expect(findTermMatches("hello world", [""])).toEqual([]);
  });
});

describe("tokenizeChunk", () => {
  function chunk(text: string): IndexedChunk {
    return {
      id: "c1",
      notePath: "n.md",
      heading: "",
      headingPath: [],
      startLine: 0,
      endLine: 0,
      tags: [],
      aliases: [],
      links: [],
      mtime: 1000,
      text,
    };
  }

  it("returns the same tokens as tokenize(chunk.text)", () => {
    const c = chunk("The Ollama server runs embeddings locally.");
    expect(tokenizeChunk(c)).toEqual(tokenize(c.text));
  });

  it("memoizes by chunk identity (same array reference on repeat calls)", () => {
    const c = chunk("hybrid retrieval fuses lexical and vector scores");
    const first = tokenizeChunk(c);
    expect(tokenizeChunk(c)).toBe(first);
  });
});

describe("diversifyByNote", () => {
  // Minimal ranked item: only notePath is read by the diversifier.
  function item(id: string, notePath: string): { chunk: IndexedChunk } {
    return {
      chunk: {
        id,
        notePath,
        heading: "",
        headingPath: [],
        startLine: 0,
        endLine: 0,
        tags: [],
        aliases: [],
        links: [],
        mtime: 1000,
        text: "",
      },
    };
  }

  it("caps how many chunks a single note contributes, promoting other notes", () => {
    const ranked = [
      item("a1", "A.md"),
      item("a2", "A.md"),
      item("a3", "A.md"),
      item("a4", "A.md"),
      item("b1", "B.md"),
    ];
    // maxPerNote 2, limit 3: A fills 2 slots, B is promoted above A's surplus.
    const out = diversifyByNote(ranked, 3, 2);
    expect(out.map((r) => r.chunk.id)).toEqual(["a1", "a2", "b1"]);
  });

  it("backfills from deferred chunks so the page is never short of the limit", () => {
    const ranked = [
      item("a1", "A.md"),
      item("a2", "A.md"),
      item("a3", "A.md"),
      item("a4", "A.md"),
    ];
    // Only one note exists; the cap must not shrink the page below the limit.
    const out = diversifyByNote(ranked, 3, 2);
    expect(out.map((r) => r.chunk.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("backfills in rank order, keeping the promoted note ahead of the surplus", () => {
    const ranked = [
      item("a1", "A.md"),
      item("a2", "A.md"),
      item("a3", "A.md"),
      item("b1", "B.md"),
    ];
    const out = diversifyByNote(ranked, 4, 2);
    // A: a1,a2 admitted; b1 promoted; a3 backfills last.
    expect(out.map((r) => r.chunk.id)).toEqual(["a1", "a2", "b1", "a3"]);
  });

  it("is a no-op when the ranking is already diverse", () => {
    const ranked = [item("a", "A.md"), item("b", "B.md"), item("c", "C.md")];
    const out = diversifyByNote(ranked, 8, 2);
    expect(out.map((r) => r.chunk.id)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty page for a non-positive limit", () => {
    expect(diversifyByNote([item("a", "A.md")], 0)).toEqual([]);
  });

  it("derives a per-note cap that scales with the limit (floor 2)", () => {
    expect(maxPerNoteFor(1)).toBe(2);
    expect(maxPerNoteFor(3)).toBe(2);
    expect(maxPerNoteFor(8)).toBe(3);
    expect(maxPerNoteFor(30)).toBe(10);
  });
});

describe("buildSnippet", () => {
  it("returns short text unchanged", () => {
    expect(buildSnippet("hello world", ["world"])).toBe("hello world");
  });

  it("falls back to the head of the text when nothing matches", () => {
    const snippet = buildSnippet("x".repeat(300), ["zzz"], 60);
    expect(snippet.startsWith("xxx")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("selects the window covering the most matches, not just the first", () => {
    const text = "needle " + "-".repeat(100) + " haystack haystack end";
    const snippet = buildSnippet(text, ["needle", "haystack"], 60);
    expect(snippet.includes("haystack haystack")).toBe(true);
    expect(snippet.includes("needle")).toBe(false);
    expect(snippet.startsWith("…")).toBe(true);
  });

  it("anchors on a whole-word match, not a substring occurrence", () => {
    const text = "restart " + "-".repeat(300) + " art here";
    const snippet = buildSnippet(text, ["art"], 60);
    expect(snippet.includes("art here")).toBe(true);
    expect(snippet.includes("restart")).toBe(false);
  });
});
