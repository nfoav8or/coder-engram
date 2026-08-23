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
    expect(store.entriesMap().size).toBe(3);
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
    expect(store.entriesMap().size).toBe(3);
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
    expect(store.entriesMap().has("c2")).toBe(false);
    expect(store.entriesMap().size).toBe(2);
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
    expect(store.entriesMap().size).toBe(0);
  });

  it("treats a legacy placeholder shell as empty on load", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    await adapter.write(FILE, JSON.stringify({ model: null, dim: 0, vectors: {} }));
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    expect(store.hasVectors()).toBe(false);
    expect(store.entriesMap().size).toBe(0);
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
      expect(store.entriesMap().size, `loaded corrupt vectors: ${label}`).toBe(0);
    }
  });
});

/** Encode floats exactly as the store does (little-endian f32 → base64). */
function b64(values: number[]): string {
  const bytes = new Uint8Array(new Float32Array(values).buffer);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

describe("EmbeddingStore v2 format", () => {
  it("persists version-2 entries: base64 vector bytes plus a finite norm", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    await store.embedIndex(makeChunks(2), new MockEmbeddingProvider());
    const disk = JSON.parse(await adapter.read(FILE)) as {
      version: number;
      vectors: Record<string, { h: string; n: number; v: string }>;
    };
    expect(disk.version).toBe(2);
    for (const entry of Object.values(disk.vectors)) {
      expect(typeof entry.h).toBe("string");
      expect(Number.isFinite(entry.n)).toBe(true);
      expect(typeof entry.v).toBe("string");
      expect(entry.v.length % 4).toBe(0);
    }
  });

  it("round-trips: entriesMap decodes to the vectors the provider produced", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const provider = new MockEmbeddingProvider();
    const chunks = makeChunks(2);
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    await store.embedIndex(chunks, provider);

    const reloaded = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await reloaded.load();
    const [expected] = await provider.embed([chunks[0].text]);
    const entry = reloaded.entriesMap().get("c0");
    expect(entry).toBeDefined();
    expect(entry!.vec.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(entry!.vec[i]).toBeCloseTo(expected[i], 5);
    }
    expect(entry!.norm).toBeGreaterThan(0);
  });

  it("migrates a version-1 file in place, keeping every vector (no re-embed)", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const chunks = makeChunks(2);
    const mockForIdentity = new MockEmbeddingProvider();
    // A v1 file whose hashes match the current chunk texts and whose model
    // string equals the mock provider's identity, so the follow-up pass reuses.
    const v1 = {
      version: 1,
      model: `${mockForIdentity.id}:${mockForIdentity.model}`,
      dim: 3,
      vectors: {
        c0: { h: contentHash(chunks[0].text), v: [1, 0, 0] },
        c1: { h: contentHash(chunks[1].text), v: [0, 1, 0] },
      },
    };
    await adapter.write(FILE, JSON.stringify(v1));
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    // The file was rewritten as v2 during load.
    const disk = JSON.parse(await adapter.read(FILE)) as { version: number };
    expect(disk.version).toBe(2);
    const entry = store.entriesMap().get("c0");
    expect(entry).toBeDefined();
    expect(Array.from(entry!.vec)).toEqual([1, 0, 0]);
    expect(entry!.norm).toBeCloseTo(1, 6);

    // And a pass under the same identity reuses everything.
    const { provider, calls } = counting(new MockEmbeddingProvider());
    const result = await store.embedIndex(chunks, provider);
    expect(result).toMatchObject({ embedded: 0, reused: 2 });
    expect(calls()).toBe(0);
  });

  it("rejects malformed version-2 entries at load", async () => {
    const wrapped = (vectors: unknown) =>
      JSON.stringify({ version: 2, model: "mock:m", dim: 3, vectors });
    const adapter = new InMemoryVaultAdapter("v");
    // Control: a valid v2 file loads.
    await adapter.write(FILE, wrapped({ c0: { h: "abc", n: 1, v: b64([1, 0, 0]) } }));
    const healthy = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await healthy.load();
    expect(healthy.entriesMap().size).toBe(1);

    const corruptions: unknown[] = [
      { c0: { h: "abc", v: b64([1, 0, 0]) } }, // missing norm
      { c0: { h: "abc", n: "1", v: b64([1, 0, 0]) } }, // norm wrong type
      { c0: { h: "abc", n: 1, v: "$$$$" } }, // invalid base64 charset
      { c0: { h: "abc", n: 1, v: "AAAAA" } }, // length not a multiple of 4
      { c0: { h: "abc", n: 1, v: 7 } }, // vector wrong type
    ];
    for (const vectors of corruptions) {
      await adapter.write(FILE, wrapped(vectors));
      const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
      await store.load();
      const label = JSON.stringify(vectors).slice(0, 60);
      expect(store.hasVectors(), `loaded corrupt vectors: ${label}`).toBe(false);
    }
  });

  it("drops entries whose bytes decode to the wrong width or to non-finite floats", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    await adapter.write(
      FILE,
      JSON.stringify({
        version: 2,
        model: "mock:m",
        dim: 3,
        vectors: {
          good: { h: "a", n: 1, v: b64([1, 0, 0]) },
          short: { h: "b", n: 1, v: b64([1, 0]) },
          nan: { h: "c", n: 1, v: b64([NaN, 0, 0]) },
        },
      }),
    );
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    const map = store.entriesMap();
    expect(map.has("good")).toBe(true);
    expect(map.has("short")).toBe(false);
    expect(map.has("nan")).toBe(false);
  });
});

describe("EmbeddingStore checkpoints and concurrency", () => {
  it("checkpoints a long pass so an interrupted run resumes instead of restarting", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const chunks = makeChunks(1100);
    const mock = new MockEmbeddingProvider();
    // Succeed for 65 batches (1040 chunks — past the 1024-chunk checkpoint),
    // then die mid-pass.
    let batches = 0;
    const dying: EmbeddingProvider = {
      id: mock.id,
      model: mock.model,
      dimensions: mock.dimensions,
      embed: async (texts) => {
        if (++batches > 65) throw new Error("provider died mid-pass");
        return mock.embed(texts);
      },
      isAvailable: async () => true,
    };
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    await expect(store.embedIndex(chunks, dying, { batchSize: 16 })).rejects.toThrow(/died/);
    // The checkpoint reached disk before the failure.
    expect(await adapter.exists(FILE)).toBe(true);

    // A fresh store resumes: the checkpointed 1024 are reused, only the tail
    // is re-embedded.
    const resumed = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await resumed.load();
    const { provider, calls } = counting(new MockEmbeddingProvider());
    const result = await resumed.embedIndex(chunks, provider, { batchSize: 16 });
    expect(result.reused).toBe(1024);
    expect(result.embedded).toBe(1100 - 1024);
    expect(calls()).toBe(Math.ceil((1100 - 1024) / 16));
  });

  it("caps in-flight batches at the configured concurrency", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const mock = new MockEmbeddingProvider();
    let inflight = 0;
    let maxInflight = 0;
    const tracking: EmbeddingProvider = {
      id: mock.id,
      model: mock.model,
      dimensions: mock.dimensions,
      embed: async (texts) => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 2));
        inflight--;
        return mock.embed(texts);
      },
      isAvailable: async () => true,
    };
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER);
    await store.load();
    await store.embedIndex(makeChunks(40), tracking, { batchSize: 4, concurrency: 3 });
    expect(maxInflight).toBeGreaterThan(1);
    expect(maxInflight).toBeLessThanOrEqual(3);

    // Default (no concurrency option) stays strictly sequential.
    inflight = 0;
    maxInflight = 0;
    const sequential = new EmbeddingStore(adapter, "Index/seq.json", NULL_LOGGER);
    await sequential.load();
    await sequential.embedIndex(makeChunks(40), tracking, { batchSize: 4 });
    expect(maxInflight).toBe(1);
  });
});
