import { describe, it, expect } from "vitest";
import { SIMILARITY_MIN_OVERLAP, findSimilarMemory } from "../src/memory/conflict";
import { IndexedChunk } from "../src/indexing/index-manager";

function chunk(notePath: string, heading: string, text: string): IndexedChunk {
  return {
    id: `${notePath}#${heading}`,
    notePath,
    heading,
    headingPath: [],
    text,
    startLine: 0,
    endLine: 1,
    tags: [],
    aliases: [],
    links: [],
    mtime: 0,
  };
}

describe("findSimilarMemory", () => {
  const stored = chunk(
    "Claude Code/Memory/Projects/Engram/decisions.md",
    "Decision — storage",
    "We chose SQLite for the durable memory store because it needs no native build.",
  );

  it("names the memory a proposal covers the same ground as", () => {
    const found = findSimilarMemory(
      "We chose SQLite for the durable memory store.",
      [stored, chunk("other.md", "Unrelated", "Tabs versus spaces in the editor config.")],
    );
    expect(found?.ref).toBe(
      "Claude Code/Memory/Projects/Engram/decisions.md#Decision — storage",
    );
    expect(found!.overlap).toBeGreaterThanOrEqual(SIMILARITY_MIN_OVERLAP);
  });

  it("still matches when the proposal CONTRADICTS the stored memory", () => {
    // The case the whole check exists for: near-identical wording, opposite
    // conclusion. Nothing offline can tell it is a contradiction — surfacing
    // the pair is what lets the agent and the reviewer see that it is.
    const found = findSimilarMemory(
      "We chose Postgres for the durable memory store because it needs no native build.",
      [stored],
    );
    expect(found).not.toBeNull();
  });

  it("stays quiet on a memory that merely shares a project's vocabulary", () => {
    const found = findSimilarMemory(
      "Session notes should be written at the end of each working session.",
      [stored],
    );
    expect(found).toBeNull();
  });

  it("says nothing about a proposal too short for a ratio to mean anything", () => {
    // Two or three terms make any ratio a coin flip; a false "this already
    // exists" is worse than silence, because it invites suppression.
    expect(findSimilarMemory("Use SQLite.", [stored])).toBeNull();
  });

  it("returns the strongest match, not the first", () => {
    const weaker = chunk("a.md", "Weak", "SQLite is one durable store among several.");
    const found = findSimilarMemory(
      "We chose SQLite for the durable memory store because it needs no native build.",
      [weaker, stored],
    );
    expect(found?.ref).toBe(
      "Claude Code/Memory/Projects/Engram/decisions.md#Decision — storage",
    );
  });

  it("is empty-safe", () => {
    expect(findSimilarMemory("anything at all here", [])).toBeNull();
    expect(findSimilarMemory("", [stored])).toBeNull();
  });
});
