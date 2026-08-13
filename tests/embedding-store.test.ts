import { describe, it, expect } from "vitest";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { EmbeddingStore, contentHash } from "../src/embeddings/embedding-store";
import { MockEmbeddingProvider } from "../src/embeddings/mock-embedding-provider";
import { EmbeddingProvider } from "../src/embeddings/embedding-provider";
import { NULL_LOGGER } from "../src/utils/logger";

const FILE = "Index/embeddings.json";

function makeChunks(n: number): { id: string; text: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `c${i}`, text: `chunk number ${i} content` }));
}

/** Wraps a provider to count embed() calls (batch invocations). */
function counting(provider: EmbeddingProvider): { provider: EmbeddingProvider; calls: () => number } {
  let calls = 0;
  const wrapped: EmbeddingProvider = {
    id: provider.id,
    model: provider.model,
    dimensions: provider.dimensions,
    embed: async (texts) => {
      calls++;
      return provider.embed(texts);
    },
    isAvailable: () => provider.isAvailable(),
  };
  return { provider: wrapped, calls: () => calls };
}

describe("contentHash", () => {
  it("is deterministic", () => {
    expect(contentHash("hello world")).toBe(contentHash("hello world"));
  });
  it("differs for different text", () => {
    expect(contentHash("alpha")).not.toBe(contentHash("beta"));
  });
  it("returns a hex string", () => {
    expect(contentHash("x")).toMatch(/^[0-9a-f]+$/);
  });
});

describe("EmbeddingStore.embedIndex", () => {
  it("embeds all chunks on the first pass and persists the file", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    const chunks = makeChunks(3);
    const result = await store.embedIndex(chunks, new MockEmbeddingProvider());
    expect(result).toMatchObject({ embedded: 3, reused: 0, removed: 0, skipped: false });
    expect(store.vectorsMap().size).toBe(3);
    expect(await adapter.exists(FILE)).toBe(true);
  });

  it("refuses a batch whose vector dimensions disagree", async () => {
    // A ragged batch means cosine similarity is comparing vectors of different
    // widths — plausible-looking scores computed from nonsense. The provider
    // layer rejects this too, but the store is what a MISBEHAVING or swapped
    // provider reaches, so the guard has to hold here as well.
    const adapter = new InMemoryVaultAdapter("v");
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    const ragged: EmbeddingProvider = {
      id: "ragged",
      model: "ragged-1",
      dimensions: 3,
      embed: async (texts) => texts.map((_, i) => (i === 0 ? [1, 0, 0] : [1, 0])),
      isAvailable: async () => true,
    };
    await expect(store.embedIndex(makeChunks(2), ragged)).rejects.toThrow(
      /inconsistent vector dimensions/i,
    );
  });

  it("reuses cached vectors when content + identity are unchanged (fresh store)", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const chunks = makeChunks(3);
    const first = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await first.load();
    await first.embedIndex(chunks, new MockEmbeddingProvider());

    const second = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await second.load();
    const result = await second.embedIndex(chunks, new MockEmbeddingProvider());
    expect(result).toMatchObject({ embedded: 0, reused: 3, removed: 0 });
  });

  it("skips the persist rewrite on a no-op refresh (nothing embedded or removed)", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const chunks = makeChunks(3);
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    await store.embedIndex(chunks, new MockEmbeddingProvider());
    const mtimeAfterFirst = await adapter.getMtime(FILE);

    // Same chunks, same provider identity → every vector reused → no disk write.
    const result = await store.embedIndex(chunks, new MockEmbeddingProvider());
    expect(result).toMatchObject({ embedded: 0, reused: 3, removed: 0 });
    expect(await adapter.getMtime(FILE)).toBe(mtimeAfterFirst);
    // In-memory vectors are still available for retrieval.
    expect(store.vectorsMap().size).toBe(3);
  });

  it("still persists when a chunk changed (guard does not swallow real writes)", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const chunks = makeChunks(3);
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    await store.embedIndex(chunks, new MockEmbeddingProvider());
    const mtimeAfterFirst = await adapter.getMtime(FILE);

    const edited = [...chunks];
    edited[0] = { id: "c0", text: "new text here" };
    await store.embedIndex(edited, new MockEmbeddingProvider());
    expect(await adapter.getMtime(FILE)).not.toBe(mtimeAfterFirst);
  });

  it("re-embeds only the chunk whose text changed", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const chunks = makeChunks(3);
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    await store.embedIndex(chunks, new MockEmbeddingProvider());

    const edited = [...chunks];
    edited[1] = { id: "c1", text: "completely different text now" };
    const result = await store.embedIndex(edited, new MockEmbeddingProvider());
    expect(result).toMatchObject({ embedded: 1, reused: 2 });
  });

  it("removes vectors for chunks dropped from the list", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const chunks = makeChunks(3);
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    await store.embedIndex(chunks, new MockEmbeddingProvider());

    const result = await store.embedIndex(chunks.slice(0, 2), new MockEmbeddingProvider());
    expect(result).toMatchObject({ embedded: 0, reused: 2, removed: 1 });
    expect(store.vectorsMap().has("c2")).toBe(false);
    expect(store.vectorsMap().size).toBe(2);
  });

  it("re-embeds everything when the provider identity changes", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const chunks = makeChunks(3);
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    await store.embedIndex(chunks, new MockEmbeddingProvider());

    // Different `model` string => different identity => full recompute.
    const altProvider: EmbeddingProvider = {
      id: "mock",
      model: "other-model",
      dimensions: 8,
      embed: async (texts) => texts.map(() => new Array<number>(8).fill(0.5)),
      isAvailable: async () => true,
    };
    const result = await store.embedIndex(chunks, altProvider);
    expect(result).toMatchObject({ embedded: 3, reused: 0 });
  });

  it("respects batchSize=1 by making one embed call per chunk", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const chunks = makeChunks(3);
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    const { provider, calls } = counting(new MockEmbeddingProvider());
    const result = await store.embedIndex(chunks, provider, { batchSize: 1 });
    expect(result.embedded).toBe(3);
    expect(calls()).toBe(3);
  });

  it("clear() empties the vectors and hasVectors becomes false", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    await store.embedIndex(makeChunks(2), new MockEmbeddingProvider());
    expect(store.hasVectors()).toBe(true);
    await store.clear();
    expect(store.hasVectors()).toBe(false);
    expect(store.vectorsMap().size).toBe(0);
  });

  it("treats a legacy placeholder shell as empty on load", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    await adapter.write(FILE, JSON.stringify({ model: null, dim: 0, vectors: {} }));
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    expect(store.hasVectors()).toBe(false);
    expect(store.vectorsMap().size).toBe(0);
  });

  /**
   * embeddings.json lives in the vault, so a sync conflict can leave a file
   * with the right envelope and wrong contents. Checking only that `vectors`
   * was an object let two failures through: an entry missing `v` threw out of
   * vectorsMap() and killed every vector search, and an array of the wrong
   * element type scored NaN — which passes the retriever's `score <= 0` filter
   * and sorts to an arbitrary rank. Recomputing is the documented answer for a
   * cache that cannot be trusted.
   */
  it("recomputes rather than trusting malformed stored vectors", async () => {
    const wrapped = (vectors: unknown) =>
      JSON.stringify({ version: 1, model: "mock:m", dim: 3, vectors });

    const adapter = new InMemoryVaultAdapter("v");
    // The control: a well-formed file must still load, or every case below
    // would pass against a load() that simply refused everything.
    await adapter.write(FILE, wrapped({ c0: { h: "abc", v: [1, 2, 3] } }));
    const healthy = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await healthy.load();
    expect(healthy.hasVectors()).toBe(true);

    const corruptions: unknown[] = [
      { c0: null },
      { c0: 7 },
      { c0: { h: "abc" } },
      { c0: { h: "abc", v: "123" } },
      { c0: { h: "abc", v: ["1", "2", "3"] } },
      { c0: { h: "abc", v: [null, null, null] } },
      { c0: { h: "abc", v: [true, true, true] } },
      { c0: { h: 5, v: [1, 2, 3] } },
      [{ h: "abc", v: [1, 2, 3] }],
      "nope",
    ];

    for (const vectors of corruptions) {
      await adapter.write(FILE, wrapped(vectors));
      const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
      await store.load();
      const label = JSON.stringify(vectors).slice(0, 50);
      expect(store.hasVectors(), `loaded corrupt vectors: ${label}`).toBe(false);
      expect(store.vectorsMap().size, `loaded corrupt vectors: ${label}`).toBe(0);
    }
  });
});
