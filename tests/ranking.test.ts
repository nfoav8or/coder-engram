import { describe, it, expect } from "vitest";
import { findTermMatches, buildSnippet } from "../src/retrieval/ranking";

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
