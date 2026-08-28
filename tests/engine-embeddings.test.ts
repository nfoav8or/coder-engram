import { describe, it, expect } from "vitest";
import { EngramEngine } from "../src/engine";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { DEFAULT_SETTINGS, EngramSettings } from "../src/settings/settings";
import { NULL_LOGGER } from "../src/utils/logger";
import { FakeHttpClient } from "../src/core/http-client";

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

describe("an INDEX_VERSION bump must not force a re-embed", () => {
  it("reuses cached vectors when the chunk index is rejected and rebuilt", async () => {
    // Vectors are keyed by chunk id and content hash and gated on provider
    // identity, so they outlive a chunk-index rebuild by design. Loading the
    // vector cache only when the index loaded meant every INDEX_VERSION bump
    // (0.11.1 raised it to 4 for every existing user) started from an empty
    // store and re-embedded the whole vault — real API spend on a paid
    // provider, for chunk text that never changed.
    //
    // Counted by PROVIDER CALLS, not by comparing vectors: a deterministic
    // provider returns byte-identical vectors whether they were reused or
    // recomputed, so a value comparison passes either way and proves nothing.
    let embedCalls = 0;
    const http = new FakeHttpClient().on(
      () => true,
      (r) => {
        if (!r.url.includes("/api/embed")) return { status: 200, body: "{}" };
        embedCalls++;
        const inputs = (JSON.parse(r.body ?? "{}") as { input: string[] }).input ?? [];
        return {
          status: 200,
          body: JSON.stringify({ embeddings: inputs.map(() => [0.1, 0.2, 0.3]) }),
        };
      },
    );
    const settings: EngramSettings = {
      ...DEFAULT_SETTINGS,
      embeddingProvider: "ollama",
      embeddingModel: "nomic",
      embeddingEndpoint: "http://127.0.0.1:11434",
    };
    const adapter = new InMemoryVaultAdapter("v", { ...SEED });
    let t = 10_000;

    const first = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++, { http });
    await first.reindex();
    expect(embedCalls, "the first pass must actually embed").toBeGreaterThan(0);

    // Simulate a vault last written by an older release: the chunk index is a
    // version this build refuses, so load() returns null and forces a rebuild.
    const meta = JSON.parse(await adapter.read("Claude Code/Index/metadata.json")) as {
      version: number;
    };
    meta.version = meta.version - 1;
    await adapter.write("Claude Code/Index/metadata.json", JSON.stringify(meta));

    embedCalls = 0;
    const upgraded = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++, { http });
    expect(await upgraded.loadIndex(), "the stale index must be rejected").toBe(false);
    await upgraded.reindex();
    expect(embedCalls, "an index-version bump must not re-embed a single chunk").toBe(0);
  });
});

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

describe("no-op refresh embedding economy", () => {
  it("skips the embedding pass on an all-unchanged refresh, and re-runs it on a real change", async () => {
    // The pass re-hashes every chunk to find work even when there is none, so
    // an all-unchanged refresh under an unchanged backend identity must not
    // start it at all — observable as zero provider traffic, liveness probe
    // included.
    const adapter = new InMemoryVaultAdapter("v", { ...SEED });
    const http = new FakeHttpClient().on(
      () => true,
      (r) => {
        if (!r.url.includes("/embeddings")) return { status: 200, body: "{}" };
        const inputs = (JSON.parse(r.body ?? "{}") as { input: string[] }).input ?? [];
        return {
          status: 200,
          body: JSON.stringify({ data: inputs.map((_, i) => ({ index: i, embedding: [0.1, 0.2, 0.3] })) }),
        };
      },
    );
    let t = 10_000;
    const engine = new EngramEngine(
      adapter,
      {
        ...DEFAULT_SETTINGS,
        embeddingProvider: "openai-compatible",
        embeddingModel: "text-embedding-3-small",
        embeddingEndpoint: "https://api.example.test/v1",
        embeddingApiKey: "sk-test",
        retrievalMode: "hybrid",
      },
      NULL_LOGGER,
      () => t++,
      { http },
    );
    await engine.reindex();
    expect(http.calls.length).toBeGreaterThan(0);

    const baseline = http.calls.length;
    await engine.refresh();
    expect(http.calls.length).toBe(baseline);

    adapter.touch("Notes/new.md", "# New\nfresh content that needs a vector.");
    await engine.refresh();
    expect(http.calls.length).toBeGreaterThan(baseline);
    const sent = http.calls.map((c) => c.body ?? "").join("\n");
    expect(sent).toContain("fresh content that needs a vector");
  });
});

describe("excluded notes and the network", () => {
  it("never sends an excluded note's text to the embedding provider", async () => {
    // The strongest privacy claim in SECURITY.md — "excluded/sensitive notes
    // are never indexed, so never embedded/sent" — held only because exclusion
    // happens before indexing and embedding reads the index. Assert it where it
    // actually matters: in the bytes that leave the machine. Using the
    // OpenAI-compatible provider over a fake HTTP client means every request
    // body is inspectable, rather than trusting the pipeline's shape.
    const adapter = new InMemoryVaultAdapter("v", {
      "Notes/public.md": "# Public\nkakapo conservation notes for the quarter.",
      "Private/secret.md": "# Secret\nkakapo TAKAHE-CLASSIFIED payroll numbers.",
      "Notes/tagged.md": "---\ntags: [private]\n---\n\n# Tagged\nkakapo MOA-CLASSIFIED board minutes.",
    });
    const http = new FakeHttpClient().on(
      () => true,
      (r) => {
        // The provider probes liveness before embedding; without a healthy
        // answer it degrades to lexical and never sends anything, which would
        // make this test pass while proving nothing.
        if (!r.url.includes("/embeddings")) return { status: 200, body: "{}" };
        const inputs = (JSON.parse(r.body ?? "{}") as { input: string[] }).input ?? [];
        return {
          status: 200,
          body: JSON.stringify({ data: inputs.map((_, i) => ({ index: i, embedding: [0.1, 0.2, 0.3] })) }),
        };
      },
    );
    let t = 10_000;
    const engine = new EngramEngine(
      adapter,
      {
        ...DEFAULT_SETTINGS,
        embeddingProvider: "openai-compatible",
        embeddingModel: "text-embedding-3-small",
        embeddingEndpoint: "https://api.example.test/v1",
        embeddingApiKey: "sk-test",
        retrievalMode: "hybrid",
        excludedFolders: ["Private"],
        excludedTags: ["private"],
      },
      NULL_LOGGER,
      () => t++,
      { http },
    );
    await engine.reindex();
    await engine.syncEmbeddings();

    const sent = http.calls.map((c) => c.body ?? "").join("\n");
    // The pipeline did run — otherwise this test proves nothing.
    expect(sent).toContain("kakapo conservation notes");
    expect(sent).not.toContain("TAKAHE-CLASSIFIED");
    expect(sent).not.toContain("MOA-CLASSIFIED");
    // Not even the excluded paths' names travel.
    expect(sent).not.toContain("Private/secret.md");
  });
});
