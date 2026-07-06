import { describe, it, expect } from "vitest";
import { EngramEngine } from "../src/engine";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { DEFAULT_SETTINGS, EngramSettings } from "../src/settings/settings";
import { NULL_LOGGER } from "../src/utils/logger";

const SEED = {
  "Notes/rag.md": "# RAG Pipeline\nThe vault indexing pipeline chunks markdown notes for retrieval.",
  "Notes/embeddings.md": "# Embeddings\nOllama and OpenAI compatible embedding backends.",
};

function makeEngine(settings: EngramSettings, seed = SEED) {
  const adapter = new InMemoryVaultAdapter("v", { ...seed });
  let t = 10_000;
  const engine = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++);
  return { adapter, engine };
}

describe("EngramEngine M3 embeddings integration", () => {
  it("reports lexical mode with the 'none' provider", () => {
    const { engine } = makeEngine({ ...DEFAULT_SETTINGS, embeddingProvider: "none" });
    expect(engine.getRetrievalMode()).toBe("lexical");
  });

  it("reports hybrid mode with the mock provider", () => {
    const { engine } = makeEngine({
      ...DEFAULT_SETTINGS,
      embeddingProvider: "mock",
      retrievalMode: "hybrid",
    });
    expect(engine.getRetrievalMode()).toBe("hybrid");
  });

  it("reindexes with the mock provider and returns hybrid search results", async () => {
    const { engine } = makeEngine({
      ...DEFAULT_SETTINGS,
      embeddingProvider: "mock",
      retrievalMode: "hybrid",
    });
    const stats = await engine.reindex();
    expect(stats.noteCount).toBe(2);

    const results = await engine.search({ query: "indexing markdown retrieval" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.chunk.notePath === "Notes/rag.md")).toBe(true);
  });

  it("serves hybrid results after a no-op refresh and picks up changes after a real one", async () => {
    const { adapter, engine } = makeEngine({
      ...DEFAULT_SETTINGS,
      embeddingProvider: "mock",
      retrievalMode: "hybrid",
    });
    await engine.reindex();
    // No-op refresh: nothing changed, so no persist and no retriever rebuild —
    // search must still serve from the existing vectors.
    await engine.refresh();
    const results = await engine.search({ query: "indexing markdown retrieval" });
    expect(results.length).toBeGreaterThan(0);

    // A real change must still flow through: new content becomes searchable.
    adapter.touch("Notes/new.md", "# New\nA fresh note about quasar telemetry.");
    await engine.refresh();
    const after = await engine.search({ query: "quasar telemetry" });
    expect(after.some((r) => r.chunk.notePath === "Notes/new.md")).toBe(true);
  });

  it("detects an embedding change when the ONE shared settings object is mutated in place", async () => {
    // Production pattern: Obsidian's settings tab mutates the single settings
    // object the engine also holds, then notifies. Comparing this.settings to
    // the incoming object compares it to itself — the engine must snapshot the
    // embedding key as its own string state instead.
    const settings: EngramSettings = { ...DEFAULT_SETTINGS, embeddingProvider: "none" };
    const adapter = new InMemoryVaultAdapter("v", { ...SEED });
    let t = 10_000;
    const engine = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++);
    await engine.reindex();
    expect(engine.getRetrievalMode()).toBe("lexical");

    settings.embeddingProvider = "mock";
    settings.retrievalMode = "hybrid";
    const changed = engine.updateSettings(settings);
    expect(changed.embeddingChanged).toBe(true);
    // The provider/retriever rebuild keys off the same flag: hybrid must
    // actually serve after the in-place switch.
    expect(engine.getRetrievalMode()).toBe("hybrid");
    await engine.reindex();
    const results = await engine.search({ query: "ollama embedding backends" });
    expect(results.some((r) => r.chunk.notePath === "Notes/embeddings.md")).toBe(true);
  });

  it("switches none -> mock via updateSettings, then a reindex populates vectors and search works", async () => {
    const { engine } = makeEngine({ ...DEFAULT_SETTINGS, embeddingProvider: "none" });
    await engine.reindex();
    expect(engine.getRetrievalMode()).toBe("lexical");

    const changed = engine.updateSettings({
      ...DEFAULT_SETTINGS,
      embeddingProvider: "mock",
      retrievalMode: "hybrid",
    });
    expect(changed.rootChanged).toBe(false);
    // The engine is the single owner of "what forces a re-embed" — the host
    // keys its background syncEmbeddings() off this flag.
    expect(changed.embeddingChanged).toBe(true);
    expect(engine.getRetrievalMode()).toBe("hybrid");

    // Batch size alone must NOT read as an embedding change (it never alters
    // the resulting vectors).
    const batchOnly = engine.updateSettings({
      ...DEFAULT_SETTINGS,
      embeddingProvider: "mock",
      retrievalMode: "hybrid",
      embeddingBatchSize: 4,
    });
    expect(batchOnly.embeddingChanged).toBe(false);

    await engine.reindex();
    const results = await engine.search({ query: "ollama embedding backends" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.chunk.notePath === "Notes/embeddings.md")).toBe(true);
  });
});
