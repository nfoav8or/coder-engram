import { describe, it, expect } from "vitest";
import {
  splitIntoSentences,
  scoreLexical,
  scoreByCentroid,
  selectSentences,
  extractiveSummary,
} from "../src/summarize/extractive";

function argmax(nums: number[]): number {
  let best = 0;
  for (let i = 1; i < nums.length; i++) if (nums[i] > nums[best]) best = i;
  return best;
}

describe("splitIntoSentences", () => {
  it("splits on sentence punctuation", () => {
    expect(splitIntoSentences("Hello world. Second sentence! Third?")).toEqual([
      "Hello world.",
      "Second sentence!",
      "Third?",
    ]);
  });

  it("strips markdown markers and ignores blank lines", () => {
    const units = splitIntoSentences("# Heading\n\n- item one\n- item two");
    expect(units).toEqual(["Heading", "item one", "item two"]);
  });
});

describe("scoreLexical", () => {
  it("ranks a sentence built from the note's most frequent word highest", () => {
    const units = ["engram engram engram", "unrelated words there", "engram system stores"];
    const scores = scoreLexical(units);
    expect(argmax(scores)).toBe(0);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[0]).toBeGreaterThan(scores[2]);
  });
});

describe("scoreByCentroid", () => {
  it("returns ~1 for identical vectors", () => {
    const scores = scoreByCentroid([
      [1, 0],
      [1, 0],
      [1, 0],
    ]);
    for (const s of scores) expect(s).toBeCloseTo(1, 5);
  });
});

describe("selectSentences", () => {
  it("returns the top-k indices in ascending order (no vectors)", () => {
    const units = ["a", "b", "c", "d"];
    const scores = [1, 5, 3, 2];
    expect(selectSentences(units, scores, 2)).toEqual([1, 2]);
  });

  it("prefers the distinct vector over a near-duplicate (MMR diversity)", () => {
    const units = ["u0", "u1", "u2"];
    const vectors = [
      [1, 0],
      [0.99, 0.01], // near-duplicate of u0
      [0, 1], // distinct
    ];
    const scores = [1, 1, 0.9];
    const picked = selectSentences(units, scores, 2, { vectors });
    expect(picked).toContain(2); // the distinct one is selected
    expect(picked).not.toContain(1); // the near-duplicate is dropped
  });
});

describe("extractiveSummary", () => {
  it("uses the embedding method when aligned vectors are supplied", () => {
    const units = ["one alpha", "two beta", "three gamma"];
    const vectors = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const summary = extractiveSummary({ units, maxSentences: 2, vectors });
    expect(summary.method).toBe("embedding");
    expect(summary.totalUnits).toBe(3);
    // indices ascending; sentences are the selected units in order.
    expect([...summary.indices].sort((a, b) => a - b)).toEqual(summary.indices);
    expect(summary.sentences).toEqual(summary.indices.map((i) => units[i]));
  });

  it("falls back to lexical without aligned vectors and returns all units when maxSentences exceeds count", () => {
    const units = ["first thing", "second thing", "third thing"];
    const summary = extractiveSummary({ units, maxSentences: 10 });
    expect(summary.method).toBe("lexical");
    expect(summary.totalUnits).toBe(3);
    expect(summary.indices).toEqual([0, 1, 2]);
    expect(summary.sentences).toEqual(units);
  });
});
