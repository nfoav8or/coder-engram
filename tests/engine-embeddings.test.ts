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

  it("switches none -> mock via updateSettings, then a reindex populates vectors and search works", async () => {
    const { engine } = makeEngine({ ...DEFAULT_SETTINGS, embeddingProvider: "none" });
    await engine.reindex();
    expect(engine.getRetrievalMode()).toBe("lexical");

    const rootChanged = engine.updateSettings({
      ...DEFAULT_SETTINGS,
      embeddingProvider: "mock",
      retrievalMode: "hybrid",
    });
    expect(rootChanged).toBe(false);
    expect(engine.getRetrievalMode()).toBe("hybrid");

    await engine.reindex();
    const results = await engine.search({ query: "ollama embedding backends" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.chunk.notePath === "Notes/embeddings.md")).toBe(true);
  });
});
