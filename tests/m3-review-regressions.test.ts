/**
 * Regression tests for the M3 /loop review findings:
 *  - H1/M2: vector cache is identity-aware; a same-provider identity change
 *    invalidates the cache, and the engine refuses to score a query against
 *    vectors from a different backend (degrades instead of returning garbage).
 *  - security LOW: the OpenAI-compatible provider rejects a `data` array whose
 *    `index` values are not a 0..n-1 permutation.
 */

import { describe, it, expect } from "vitest";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { FakeHttpClient } from "../src/core/http-client";
import { EmbeddingStore } from "../src/embeddings/embedding-store";
import { MockEmbeddingProvider } from "../src/embeddings/mock-embedding-provider";
import { OpenAiEmbeddingProvider } from "../src/embeddings/openai-embedding-provider";
import { EngramEngine } from "../src/engine";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import { NULL_LOGGER } from "../src/utils/logger";

describe("EmbeddingStore identity awareness (H1/M2)", () => {
  const chunks = [
    { id: "a", text: "alpha content" },
    { id: "b", text: "beta content" },
  ];

  it("exposes stored identity + dim, and a DIFFERENT identity forces a full recompute", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const store = new EmbeddingStore(adapter, "Index/embeddings.json");
    const provider = new MockEmbeddingProvider();

    const r1 = await store.embedIndex(chunks, provider, { identity: "backend-A" });
    expect(r1).toMatchObject({ embedded: 2, reused: 0 });
    expect(store.identity()).toBe("backend-A");
    expect(store.dim()).toBe(provider.dimensions);

    // Same provider object + same text, but a NEW identity (e.g. endpoint/key
    // changed) must invalidate every vector — the M2 fix.
    const r2 = await store.embedIndex(chunks, provider, { identity: "backend-B" });
    expect(r2).toMatchObject({ embedded: 2, reused: 0 });
    expect(store.identity()).toBe("backend-B");

    // Same identity again reuses everything.
    const r3 = await store.embedIndex(chunks, provider, { identity: "backend-B" });
    expect(r3).toMatchObject({ embedded: 0, reused: 2 });
  });
});

describe("Engine refuses stale vectors after an identity change (H1)", () => {
  function buildEngine(mode: "vector" | "hybrid", model: string) {
    const adapter = new InMemoryVaultAdapter("v", {
      "Notes/a.md": "# Alpha\nalpha beta gamma vector retrieval search",
      "Notes/b.md": "# Beta\ndelta epsilon zeta",
    });
    const settings = {
      ...DEFAULT_SETTINGS,
      embeddingProvider: "mock" as const,
      embeddingModel: model,
      retrievalMode: mode,
    };
    return { engine: new EngramEngine(adapter, settings, NULL_LOGGER), settings };
  }

  it("vector-only mode returns nothing (not garbage) when vectors are from another backend", async () => {
    const { engine } = buildEngine("vector", "model-A");
    await engine.reindex(); // embeds with identity for model-A
    const before = await engine.search({ query: "alpha" });
    expect(before.length).toBeGreaterThan(0); // identity matches → vector results

    // Change the model (=> vectorIdentity changes) WITHOUT re-embedding.
    engine.updateSettings({
      ...DEFAULT_SETTINGS,
      embeddingProvider: "mock",
      embeddingModel: "model-B",
      retrievalMode: "vector",
    });
    const after = await engine.search({ query: "alpha" });
    // The gate refuses to embed the query against stale model-A vectors, so a
    // pure-vector search yields nothing rather than plausible-but-wrong hits.
    expect(after.length).toBe(0);
  });

  it("hybrid mode still returns lexical results (never fails closed) after the swap", async () => {
    const { engine } = buildEngine("hybrid", "model-A");
    await engine.reindex();
    engine.updateSettings({
      ...DEFAULT_SETTINGS,
      embeddingProvider: "mock",
      embeddingModel: "model-B",
      retrievalMode: "hybrid",
    });
    const after = await engine.search({ query: "alpha beta" });
    expect(after.length).toBeGreaterThan(0); // lexical component still serves results
  });
});

describe("OpenAI-compatible index permutation guard (security LOW)", () => {
  function make(http: FakeHttpClient) {
    return new OpenAiEmbeddingProvider({ http, endpoint: "https://api.example/v1", model: "m", apiKey: "k" });
  }
  const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });

  it("throws on a duplicated index", async () => {
    const http = new FakeHttpClient().on(
      () => true,
      () => ok({ data: [{ index: 0, embedding: [1, 1] }, { index: 0, embedding: [2, 2] }] }),
    );
    await expect(make(http).embed(["a", "b"])).rejects.toThrow(/permutation/);
  });

  it("throws on a missing index (gap)", async () => {
    const http = new FakeHttpClient().on(
      () => true,
      () => ok({ data: [{ index: 0, embedding: [1, 1] }, { index: 2, embedding: [2, 2] }] }),
    );
    await expect(make(http).embed(["a", "b"])).rejects.toThrow(/permutation/);
  });

  it("keeps response order when the server omits index entirely", async () => {
    const http = new FakeHttpClient().on(
      () => true,
      () => ok({ data: [{ embedding: [9, 9] }, { embedding: [8, 8] }] }),
    );
    expect(await make(http).embed(["a", "b"])).toEqual([[9, 9], [8, 8]]);
  });
});
