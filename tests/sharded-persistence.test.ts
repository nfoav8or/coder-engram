import { describe, it, expect } from "vitest";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { VaultScanner, ScanConfig } from "../src/indexing/vault-scanner";
import { IndexManager } from "../src/indexing/index-manager";
import { EmbeddingStore } from "../src/embeddings/embedding-store";
import { MockEmbeddingProvider } from "../src/embeddings/mock-embedding-provider";
import { EmbeddingProvider } from "../src/embeddings/embedding-provider";
import { fnv1a32 } from "../src/utils/hash";
import { NULL_LOGGER } from "../src/utils/logger";

const PATHS = {
  chunksFile: "Index/chunks.json",
  metadataFile: "Index/metadata.json",
  embeddingsFile: "Index/embeddings.json",
};

function scanConfig(): ScanConfig {
  return { includedFolders: [], excludedFolders: [], excludedTags: [], excludedPathPatterns: [], indexAttachments: false };
}

/** Seed n notes, each yielding one chunk. */
function seedNotes(n: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    files[`Notes/n${i}.md`] = `# Note ${i}\nBody of note number ${i} with steady content.`;
  }
  return files;
}

const chunkShardFile = (i: number) => `Index/chunks-${i.toString(16).padStart(2, "0")}.json`;
const embShardFile = (i: number) => `Index/embeddings-${i.toString(16).padStart(2, "0")}.json`;

async function mtimes(adapter: InMemoryVaultAdapter, files: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (const f of files) out.set(f, await adapter.getMtime(f));
  return out;
}

describe("size-adaptive sharded chunk persistence", () => {
  const opts = { singleFileMaxChunks: 10, logger: NULL_LOGGER };

  it("persists sharded above the threshold and round-trips through load", async () => {
    const adapter = new InMemoryVaultAdapter("v", seedNotes(15));
    const mgr = new IndexManager(adapter, PATHS, opts);
    await mgr.build(await new VaultScanner(adapter).scan(scanConfig()));
    await mgr.persist();

    const metadata = JSON.parse(await adapter.read(PATHS.metadataFile)) as { layout?: string; shardCount?: number };
    expect(metadata.layout).toBe("sharded");
    expect(metadata.shardCount).toBe(256);
    // The monolith is a blank sentinel, never read for this layout.
    expect(await adapter.read(PATHS.chunksFile)).toBe("[]");

    const reloaded = new IndexManager(adapter, PATHS, opts);
    const index = await reloaded.load();
    expect(index).not.toBeNull();
    const ids = (index?.chunks ?? []).map((c) => c.id).sort();
    expect(ids).toHaveLength(15);
    expect(new Set(ids).size).toBe(15);
    expect(ids.every((id) => id.startsWith("Notes/"))).toBe(true);
  });

  it("rewrites only the changed note's shard on an incremental persist", async () => {
    const adapter = new InMemoryVaultAdapter("v", seedNotes(15));
    const mgr = new IndexManager(adapter, PATHS, opts);
    const scanner = new VaultScanner(adapter);
    await mgr.build(await scanner.scan(scanConfig()));
    await mgr.persist();

    const shardFiles = Array.from({ length: 256 }, (_, i) => chunkShardFile(i));
    const before = await mtimes(adapter, shardFiles);

    adapter.touch("Notes/n3.md", "# Note 3\nEdited body.");
    await mgr.refresh(await scanner.scan(scanConfig(), mgr.getNoteMtimes()));
    await mgr.persist();

    const after = await mtimes(adapter, shardFiles);
    const changed = shardFiles.filter((f) => before.get(f) !== after.get(f));
    expect(changed).toEqual([chunkShardFile(fnv1a32("Notes/n3.md") % 256)]);
  });

  it("migrates single -> sharded -> single as the corpus crosses the thresholds", async () => {
    const adapter = new InMemoryVaultAdapter("v", seedNotes(5));
    const mgr = new IndexManager(adapter, PATHS, opts);
    const scanner = new VaultScanner(adapter);
    await mgr.build(await scanner.scan(scanConfig()));
    await mgr.persist();
    // Small corpus: classic single-file layout, no layout field written.
    expect((JSON.parse(await adapter.read(PATHS.chunksFile)) as unknown[]).length).toBe(5);
    expect((JSON.parse(await adapter.read(PATHS.metadataFile)) as { layout?: string }).layout).toBeUndefined();

    // Grow past the threshold: layout switches up.
    for (let i = 5; i < 15; i++) adapter.touch(`Notes/n${i}.md`, `# Note ${i}\nBody ${i}.`);
    await mgr.refresh(await scanner.scan(scanConfig(), mgr.getNoteMtimes()));
    await mgr.persist();
    expect((JSON.parse(await adapter.read(PATHS.metadataFile)) as { layout?: string }).layout).toBe("sharded");
    expect(await adapter.read(PATHS.chunksFile)).toBe("[]");

    // Shrink far below (hysteresis floor is 8): layout switches back down.
    for (let i = 2; i < 15; i++) adapter.removeFile(`Notes/n${i}.md`);
    await mgr.refresh(await scanner.scan(scanConfig(), mgr.getNoteMtimes()));
    await mgr.persist();
    const meta = JSON.parse(await adapter.read(PATHS.metadataFile)) as { layout?: string };
    expect(meta.layout).toBeUndefined();
    expect((JSON.parse(await adapter.read(PATHS.chunksFile)) as unknown[]).length).toBe(2);
    // Obsolete shards are blanked sentinels.
    expect(await adapter.read(chunkShardFile(fnv1a32("Notes/n1.md") % 256))).toBe("[]");
  });

  it("rebuilds when a shard is corrupt or the shard count is unexpected", async () => {
    const adapter = new InMemoryVaultAdapter("v", seedNotes(15));
    const mgr = new IndexManager(adapter, PATHS, opts);
    await mgr.build(await new VaultScanner(adapter).scan(scanConfig()));
    await mgr.persist();

    const shard = chunkShardFile(fnv1a32("Notes/n0.md") % 256);
    await adapter.write(shard, "{ not json");
    expect(await new IndexManager(adapter, PATHS, opts).load()).toBeNull();

    await adapter.write(shard, JSON.stringify([{ nonsense: true }]));
    expect(await new IndexManager(adapter, PATHS, opts).load()).toBeNull();

    // Restore the shard but claim a shard count this code never writes.
    await mgr.persist();
    const meta = JSON.parse(await adapter.read(PATHS.metadataFile)) as { shardCount?: number };
    meta.shardCount = 64;
    await adapter.write(PATHS.metadataFile, JSON.stringify(meta));
    expect(await new IndexManager(adapter, PATHS, opts).load()).toBeNull();
  });
});

describe("size-adaptive sharded embeddings persistence", () => {
  const FILE = PATHS.embeddingsFile;
  const storeOpts = { singleFileMaxVectors: 10 };
  const makeChunks = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `Notes/n${i}.md::0`, text: `chunk ${i} body` }));

  it("persists a manifest plus shards above the threshold and round-trips", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER, storeOpts);
    await store.load();
    await store.embedIndex(makeChunks(15), new MockEmbeddingProvider());

    const manifest = JSON.parse(await adapter.read(FILE)) as { layout?: string; vectors?: unknown };
    expect(manifest.layout).toBe("sharded");
    expect(manifest.vectors).toBeUndefined();

    const reloaded = new EmbeddingStore(adapter, FILE, NULL_LOGGER, storeOpts);
    await reloaded.load();
    expect(reloaded.entriesMap().size).toBe(15);

    // Same chunks, same identity: everything reused, no provider calls.
    let calls = 0;
    const mock = new MockEmbeddingProvider();
    const counting: EmbeddingProvider = {
      id: mock.id,
      model: mock.model,
      dimensions: mock.dimensions,
      embed: (texts) => (calls++, mock.embed(texts)),
      isAvailable: async () => true,
    };
    const result = await reloaded.embedIndex(makeChunks(15), counting);
    expect(result).toMatchObject({ embedded: 0, reused: 15 });
    expect(calls).toBe(0);
  });

  it("rewrites only the shards an edit touched", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER, storeOpts);
    await store.load();
    const chunks = makeChunks(15);
    await store.embedIndex(chunks, new MockEmbeddingProvider());

    const shardFiles = Array.from({ length: 256 }, (_, i) => embShardFile(i));
    const before = await mtimes(adapter, shardFiles);

    const edited = [...chunks];
    edited[4] = { id: chunks[4].id, text: "totally new text" };
    await store.embedIndex(edited, new MockEmbeddingProvider());

    const after = await mtimes(adapter, shardFiles);
    const changed = shardFiles.filter((f) => before.get(f) !== after.get(f));
    expect(changed).toEqual([embShardFile(fnv1a32(chunks[4].id) % 256)]);
  });

  it("a corrupt shard loses only its own vectors; the rest are reused", async () => {
    const adapter = new InMemoryVaultAdapter("v");
    const store = new EmbeddingStore(adapter, FILE, NULL_LOGGER, storeOpts);
    await store.load();
    const chunks = makeChunks(15);
    await store.embedIndex(chunks, new MockEmbeddingProvider());

    const victim = chunks[7].id;
    await adapter.write(embShardFile(fnv1a32(victim) % 256), "{ torn");

    const reloaded = new EmbeddingStore(adapter, FILE, NULL_LOGGER, storeOpts);
    await reloaded.load();
    // Only the torn shard's vectors are gone.
    const survivors = reloaded.entriesMap();
    expect(survivors.has(victim)).toBe(false);
    expect(survivors.size).toBeGreaterThan(0);

    // A pass re-embeds exactly the dropped ids and reuses the rest.
    const dropped = chunks.filter((c) => !survivors.has(c.id)).length;
    const result = await reloaded.embedIndex(chunks, new MockEmbeddingProvider());
    expect(result.embedded).toBe(dropped);
    expect(result.reused).toBe(15 - dropped);
  });
});
