import { describe, it, expect } from "vitest";
import { MIN_DECAY, applyMemoryDecay, decayFactor, memoryRecordedAt } from "../src/memory/decay";
import { IndexedChunk } from "../src/indexing/index-manager";

const DAY = 86_400_000;

function chunk(heading: string, mtime: number, notePath = "Claude Code/Memory/a.md"): IndexedChunk {
  return {
    id: `${notePath}#${heading}`,
    notePath,
    heading,
    headingPath: [],
    text: "body",
    startLine: 0,
    endLine: 1,
    tags: [],
    aliases: [],
    links: [],
    symbols: [],
    mtime,
  };
}

describe("decayFactor", () => {
  it("halves the weight every half-life", () => {
    expect(decayFactor(0, 30)).toBe(1);
    expect(decayFactor(30 * DAY, 30)).toBeCloseTo(0.5, 6);
    expect(decayFactor(60 * DAY, 30)).toBeCloseTo(0.25, 6);
  });

  it("never falls below the floor", () => {
    // A memory you cannot retrieve is a memory you have lost. Ageing orders
    // memory; it does not delete it.
    expect(decayFactor(10_000 * DAY, 30)).toBe(MIN_DECAY);
  });

  it("is off at a zero or negative half-life", () => {
    expect(decayFactor(365 * DAY, 0)).toBe(1);
    expect(decayFactor(365 * DAY, -5)).toBe(1);
  });

  it("does not reward a future date", () => {
    // Clock skew and a hand-typed heading both produce these; letting them
    // exceed 1 would make a wrong date a way to win every ranking.
    expect(decayFactor(-100 * DAY, 30)).toBe(1);
  });
});

describe("memoryRecordedAt", () => {
  it("reads the timestamp the applied heading carries", () => {
    const at = memoryRecordedAt(chunk("Decision — 2026-07-03 14:22 · k3f9a1", 0));
    expect(at).toBe(new Date(2026, 6, 3, 14, 22).getTime());
  });

  it("falls back to the file mtime when the heading has no timestamp", () => {
    expect(memoryRecordedAt(chunk("Some ordinary heading", 12_345))).toBe(12_345);
  });

  it("dates each memory separately, not by the file's last edit", () => {
    // Falling back to mtime alone would date every memory in a file by its last
    // edit, so adding one decision would make every older decision beside it
    // look new — decay that resets itself is worse than none, because it looks
    // like it works.
    const edited = 9_999_999_999_999;
    const old = memoryRecordedAt(chunk("Decision — 2020-01-01 09:00 · aaa", edited));
    const recent = memoryRecordedAt(chunk("Decision — 2026-01-01 09:00 · bbb", edited));
    expect(old).toBeLessThan(recent);
    expect(recent).not.toBe(edited);
  });
});

describe("applyMemoryDecay", () => {
  const now = new Date(2026, 6, 3, 14, 22).getTime();
  const isMemory = (p: string) => p.startsWith("Claude Code/Memory/");

  function result(c: IndexedChunk, score: number) {
    return { chunk: c, score };
  }

  it("lets a recent memory overtake an older, higher-scoring one", () => {
    const stale = result(chunk("Decision — 2024-01-01 09:00 · a", 0), 1.0);
    const fresh = result(chunk("Decision — 2026-07-01 09:00 · b", 0), 0.8);
    const out = applyMemoryDecay([stale, fresh], now, 90, isMemory);
    expect(out[0].chunk.heading).toContain("2026-07-01");
  });

  it("leaves ordinary notes alone", () => {
    // They are documents, not claims that go stale, and decaying the whole
    // vault would change what search means for everyone who wanted this for
    // their memory.
    const note = result(chunk("Old note", 0, "Notes/ancient.md"), 1.0);
    const memory = result(chunk("Decision — 2020-01-01 09:00 · a", 0), 1.0);
    const out = applyMemoryDecay([note, memory], now, 30, isMemory);
    expect(out[0].chunk.notePath).toBe("Notes/ancient.md");
    expect(out.find((r) => r.chunk.notePath === "Notes/ancient.md")!.score).toBe(1.0);
  });

  it("returns the same array untouched when the feature is off", () => {
    const input = [result(chunk("Decision — 2020-01-01 09:00 · a", 0), 1.0)];
    expect(applyMemoryDecay(input, now, 0, isMemory)).toBe(input);
  });

  it("returns the same array when nothing in the results is memory", () => {
    const input = [result(chunk("A", 0, "Notes/a.md"), 1.0)];
    expect(applyMemoryDecay(input, now, 30, isMemory)).toBe(input);
  });

  it("does not mutate the results it was given", () => {
    const stale = result(chunk("Decision — 2020-01-01 09:00 · a", 0), 1.0);
    applyMemoryDecay([stale], now, 30, isMemory);
    expect(stale.score).toBe(1.0);
  });
});
