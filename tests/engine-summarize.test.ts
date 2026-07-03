import { describe, it, expect } from "vitest";
import { EngramEngine } from "../src/engine";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { DEFAULT_SETTINGS, EngramSettings } from "../src/settings/settings";
import { NULL_LOGGER } from "../src/utils/logger";
import { ConfigError } from "../src/utils/errors";

const NOTE = `# Alpha Note
The indexing pipeline chunks markdown notes for retrieval.
Embeddings power the vector retriever when a provider is set.
The review inbox keeps human-in-the-loop control over memory.
Extractive summaries reuse the note's own sentences.`;

function makeEngine(
  seed: Record<string, string>,
  overrides: Partial<EngramSettings> = {},
) {
  const adapter = new InMemoryVaultAdapter("v", seed);
  const settings: EngramSettings = { ...DEFAULT_SETTINGS, ...overrides };
  let t = 10_000;
  const engine = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++);
  return { adapter, engine };
}

describe("EngramEngine.getNoteChunks", () => {
  it("returns chunks for an indexed note and [] for an unindexed one", async () => {
    const { engine } = makeEngine({ "Notes/a.md": NOTE });
    await engine.reindex();
    expect(engine.getNoteChunks("Notes/a.md").length).toBeGreaterThan(0);
    expect(engine.getNoteChunks("Notes/missing.md")).toEqual([]);
  });
});

describe("EngramEngine.summarizeNote", () => {
  it("summarizes an indexed note", async () => {
    const { engine } = makeEngine({ "Notes/a.md": NOTE });
    await engine.reindex();
    const summary = await engine.summarizeNote("Notes/a.md");
    expect(summary.notePath).toBe("Notes/a.md");
    expect(summary.sentences.length).toBeGreaterThan(0);
    expect(summary.totalUnits).toBeGreaterThan(0);
    expect(summary.chunkCount).toBeGreaterThan(0);
    expect(summary.truncated).toBe(false);
    expect(["lexical", "embedding"]).toContain(summary.method);
  });

  it("rejects a nonexistent (unindexed) path", async () => {
    const { engine } = makeEngine({ "Notes/a.md": NOTE });
    await engine.reindex();
    await expect(engine.summarizeNote("Notes/missing.md")).rejects.toBeInstanceOf(ConfigError);
  });

  it("rejects a note in an excluded folder", async () => {
    const { engine } = makeEngine(
      { "Notes/a.md": NOTE, "Private/secret.md": NOTE },
      { excludedFolders: ["Private"] },
    );
    await engine.reindex();
    expect(engine.getNoteChunks("Private/secret.md")).toEqual([]);
    await expect(engine.summarizeNote("Private/secret.md")).rejects.toBeInstanceOf(ConfigError);
  });

  it("uses the embedding method with a mock provider", async () => {
    const { engine } = makeEngine({ "Notes/a.md": NOTE }, { embeddingProvider: "mock" });
    await engine.reindex();
    const summary = await engine.summarizeNote("Notes/a.md");
    expect(summary.method).toBe("embedding");
  });

  it("uses the lexical method with no provider", async () => {
    const { engine } = makeEngine({ "Notes/a.md": NOTE }, { embeddingProvider: "none" });
    await engine.reindex();
    const summary = await engine.summarizeNote("Notes/a.md");
    expect(summary.method).toBe("lexical");
  });

  it("clamps maxSentences (0 -> at least 1, huge -> capped at available)", async () => {
    const { engine } = makeEngine({ "Notes/a.md": NOTE });
    await engine.reindex();

    const low = await engine.summarizeNote("Notes/a.md", { maxSentences: 0 });
    expect(low.sentences.length).toBeGreaterThanOrEqual(1);

    const high = await engine.summarizeNote("Notes/a.md", { maxSentences: 999 });
    expect(high.sentences.length).toBeLessThanOrEqual(Math.min(20, high.totalUnits));
    expect(high.sentences.length).toBe(high.totalUnits); // fewer than 20 units -> all returned
  });

  it("does not repeat the exact same sentence", async () => {
    const { engine } = makeEngine({ "Notes/a.md": NOTE });
    await engine.reindex();
    const summary = await engine.summarizeNote("Notes/a.md", { maxSentences: 20 });
    expect(new Set(summary.sentences).size).toBe(summary.sentences.length);
  });
});
