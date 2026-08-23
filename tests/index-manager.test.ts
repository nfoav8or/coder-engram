import { describe, it, expect } from "vitest";
import { IndexManager, IndexPaths, INDEX_VERSION } from "../src/indexing/index-manager";
import { VaultScanner } from "../src/indexing/vault-scanner";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";

const PATHS: IndexPaths = {
  chunksFile: "Claude Code/Index/chunks.json",
  metadataFile: "Claude Code/Index/metadata.json",
  embeddingsFile: "Claude Code/Index/embeddings.json",
};

function scanConfig(overrides = {}) {
  return {
    includedFolders: [],
    excludedFolders: [],
    excludedTags: [],
    excludedPathPatterns: [],
    ...overrides,
  };
}

let clock = 100;
const nextClock = () => clock++;

describe("IndexManager build + persist + load", () => {
  it("builds an index from scanned notes", async () => {
    const adapter = new InMemoryVaultAdapter("v", {
      "Notes/a.md": "# Alpha\nalpha content about widgets",
      "Notes/b.md": "# Beta\nbeta content about gadgets",
    });
    const scanner = new VaultScanner(adapter);
    const notes = await scanner.scan(scanConfig());
    const mgr = new IndexManager(adapter, PATHS, { clock: nextClock });
    const index = await mgr.build(notes);
    expect(index.metadata.noteCount).toBe(2);
    expect(index.chunks.length).toBeGreaterThanOrEqual(2);
    expect(index.chunks[0].notePath).toBeTruthy();
  });

  it("persists and reloads the index", async () => {
    const adapter = new InMemoryVaultAdapter("v", {
      "Notes/a.md": "# Alpha\ncontent",
    });
    const notes = await new VaultScanner(adapter).scan(scanConfig());
    const mgr = new IndexManager(adapter, PATHS, { clock: nextClock });
    await mgr.build(notes);
    await mgr.persist();

    const reloaded = new IndexManager(adapter, PATHS, { clock: nextClock });
    const loaded = await reloaded.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.chunks.length).toBe(mgr.getChunks().length);
  });

  it("refuses an index written by an older INDEX_VERSION", async () => {
    // The version is what makes chunks.json a rebuildable CACHE rather than
    // durable state: a chunker change alters chunk boundaries and line spans,
    // so a stale file must force a rebuild instead of being served as if the
    // current code had produced it.
    const adapter = new InMemoryVaultAdapter("v", { "Notes/a.md": "# Alpha\ncontent" });
    const notes = await new VaultScanner(adapter).scan(scanConfig());
    const mgr = new IndexManager(adapter, PATHS, { clock: nextClock });
    await mgr.build(notes);
    await mgr.persist();

    const meta = JSON.parse(await adapter.read(PATHS.metadataFile)) as { version: number };
    expect(meta.version).toBe(INDEX_VERSION);
    await adapter.write(PATHS.metadataFile, JSON.stringify({ ...meta, version: INDEX_VERSION - 1 }));

    expect(await new IndexManager(adapter, PATHS, { clock: nextClock }).load()).toBeNull();
  });

  it("returns null when loading a missing index", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const mgr = new IndexManager(adapter, PATHS, { clock: nextClock });
    expect(await mgr.load()).toBeNull();
  });

  /**
   * A chunks.json that parses as an array but holds the wrong shapes used to
   * load clean and then throw a TypeError out of the retriever on every query,
   * leaving a plugin that reports an index and cannot search. Rebuilding is the
   * same answer the version check already gives, and for the same reason: the
   * file is a cache, so the recovery is to rebuild it rather than serve it.
   */
  it("refuses an index whose chunks are the wrong shape", async () => {
    const adapter = new InMemoryVaultAdapter("v", { "Notes/a.md": "# Alpha\ncontent" });
    const notes = await new VaultScanner(adapter).scan(scanConfig());
    const mgr = new IndexManager(adapter, PATHS, { clock: nextClock });
    await mgr.build(notes);
    await mgr.persist();
    const good = JSON.parse(await adapter.read(PATHS.chunksFile)) as Record<string, unknown>[];

    // The control: untouched, it still loads. Without this the cases below
    // would pass just as well against a load() that refused everything.
    expect(await new IndexManager(adapter, PATHS, { clock: nextClock }).load()).not.toBeNull();

    const corruptions: Record<string, unknown>[] = [
      [null],
      [1, 2, 3],
      [{ ...good[0], text: undefined }],
      [{ ...good[0], text: 42 }],
      [{ ...good[0], tags: "work" }],
      [{ ...good[0], links: 7 }],
      [{ ...good[0], startLine: "1" }],
      [...good, null],
    ] as unknown as Record<string, unknown>[];

    for (const corrupt of corruptions) {
      await adapter.write(PATHS.chunksFile, JSON.stringify(corrupt));
      const loaded = await new IndexManager(adapter, PATHS, { clock: nextClock }).load();
      expect(loaded, `loaded a corrupt index: ${JSON.stringify(corrupt).slice(0, 60)}`).toBeNull();
    }
  });
});

describe("IndexManager incremental refresh", () => {
  it("keeps unchanged notes, updates changed, removes deleted", async () => {
    const adapter = new InMemoryVaultAdapter("v", {
      "Notes/a.md": "# Alpha\noriginal",
      "Notes/b.md": "# Beta\noriginal",
    });
    const scanner = new VaultScanner(adapter);
    const mgr = new IndexManager(adapter, PATHS, { clock: nextClock });
    await mgr.build(await scanner.scan(scanConfig()));

    // Modify a.md (bumps mtime), delete b.md, add c.md.
    adapter.touch("Notes/a.md", "# Alpha\nCHANGED content");
    // Simulate deletion by constructing a fresh adapter without b.
    const adapter2 = new InMemoryVaultAdapter("v", {
      "Notes/a.md": "# Alpha\nCHANGED content",
      "Notes/c.md": "# Gamma\nnew note",
    });
    const mgr2 = new IndexManager(adapter2, PATHS, { clock: nextClock });
    await mgr2.build(await scanner.scan(scanConfig())); // seed with a+b (old adapter)

    const result = await mgr2.refresh(await new VaultScanner(adapter2).scan(scanConfig()));
    // Whatever the exact prior state, c is added and b removed relative to seed.
    expect(result.added + result.updated + result.unchanged).toBeGreaterThan(0);
    const paths = mgr2.getChunks().map((c) => c.notePath);
    expect(paths).toContain("Notes/c.md");
    expect(paths).not.toContain("Notes/b.md");
  });

  it("marks a note unchanged when its mtime is stable", async () => {
    const adapter = new InMemoryVaultAdapter("v", {
      "Notes/a.md": "# Alpha\nstable",
    });
    const scanner = new VaultScanner(adapter);
    const mgr = new IndexManager(adapter, PATHS, { clock: nextClock });
    const notes = await scanner.scan(scanConfig());
    await mgr.build(notes);
    const result = await mgr.refresh(notes); // same notes, same mtime
    expect(result.unchanged).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.added).toBe(0);
  });

  it("preserves the chunks array identity across an all-unchanged refresh", async () => {
    const adapter = new InMemoryVaultAdapter("v", {
      "Notes/a.md": "# Alpha\nstable",
      "Notes/b.md": "# Beta\nalso stable",
    });
    const scanner = new VaultScanner(adapter);
    const mgr = new IndexManager(adapter, PATHS, { clock: nextClock });
    const notes = await scanner.scan(scanConfig());
    await mgr.build(notes);
    const before = mgr.getChunks();
    await mgr.refresh(notes);
    // Same ARRAY OBJECT, not just equal contents: retrieval memoizes corpus
    // stats by chunks-array identity, so swapping in an equal-content array
    // would silently re-pay the full stats build on the next query.
    expect(mgr.getChunks()).toBe(before);

    adapter.touch("Notes/a.md", "# Alpha\nCHANGED");
    await mgr.refresh(await scanner.scan(scanConfig()));
    expect(mgr.getChunks()).not.toBe(before);
  });

  it("treats a zero-chunk (empty) note as unchanged, not perpetually added", async () => {
    // An empty note produces no chunks, so chunk-derived identity would count
    // it as "added" on EVERY refresh — keeping the all-unchanged fast path
    // (skip persist, keep array identity) from ever engaging.
    const adapter = new InMemoryVaultAdapter("v", {
      "Notes/a.md": "# Alpha\nstable",
      "Notes/empty.md": "",
    });
    const scanner = new VaultScanner(adapter);
    const mgr = new IndexManager(adapter, PATHS, { clock: nextClock });
    await mgr.build(await scanner.scan(scanConfig()));
    const before = mgr.getChunks();

    const result = await mgr.refresh(await scanner.scan(scanConfig()));
    expect(result).toEqual({ added: 0, updated: 0, removed: 0, unchanged: 2 });
    expect(mgr.getChunks()).toBe(before);

    // An empty note gaining content is an update and becomes indexed.
    adapter.touch("Notes/empty.md", "# Filled\nnow has content");
    const result2 = await mgr.refresh(await scanner.scan(scanConfig()));
    expect(result2.updated).toBe(1);
    expect(result2.added).toBe(0);
    expect(mgr.getChunks().map((c) => c.notePath)).toContain("Notes/empty.md");
  });

  it("still treats it as unchanged after a persist and reload, not just in-session", async () => {
    // The test above proves it settles WITHIN one manager, which is where the
    // mtime map lives in memory. Across a restart the map was gone and mtimes
    // were re-derived from chunks, where a zero-chunk note leaves no trace — so
    // it read as added on the first refresh of every session, and "added" is
    // what makes the engine persist the whole index. One empty note therefore
    // rewrote tens of MB on the app's main thread at every startup, forever.
    const adapter = new InMemoryVaultAdapter("v", {
      "Notes/a.md": "# Alpha\nstable",
      "Notes/empty.md": "",
      "Notes/blank.md": "   \n\n  \n",
    });
    const scanner = new VaultScanner(adapter);
    const first = new IndexManager(adapter, PATHS, { clock: nextClock });
    await first.build(await scanner.scan(scanConfig()));
    await first.persist();

    for (let session = 0; session < 2; session++) {
      const reloaded = new IndexManager(adapter, PATHS, { clock: nextClock });
      expect(await reloaded.load()).not.toBeNull();
      const result = await reloaded.refresh(await scanner.scan(scanConfig(), reloaded.getNoteMtimes()));
      expect(result).toEqual({ added: 0, updated: 0, removed: 0, unchanged: 3 });
      await reloaded.persist();
    }
  });

  it("reloads an index written before the mtime map existed", async () => {
    // Backward compatibility: the field is optional, so an index persisted by
    // an older build must still load and work rather than force a rebuild.
    const adapter = new InMemoryVaultAdapter("v", { "Notes/a.md": "# Alpha\nstable" });
    const scanner = new VaultScanner(adapter);
    const mgr = new IndexManager(adapter, PATHS, { clock: nextClock });
    await mgr.build(await scanner.scan(scanConfig()));
    await mgr.persist();

    const meta = JSON.parse(await adapter.read(PATHS.metadataFile)) as Record<string, unknown>;
    expect(meta.noteMtimes).toBeDefined();
    delete meta.noteMtimes;
    await adapter.write(PATHS.metadataFile, JSON.stringify(meta));

    const reloaded = new IndexManager(adapter, PATHS, { clock: nextClock });
    expect(await reloaded.load()).not.toBeNull();
    expect(reloaded.getNoteMtimes().get("Notes/a.md")).toBeDefined();
    const result = await reloaded.refresh(await scanner.scan(scanConfig(), reloaded.getNoteMtimes()));
    expect(result.removed).toBe(0);
    // And it writes the map going forward, so the next session is clean.
    await reloaded.persist();
    const after = JSON.parse(await adapter.read(PATHS.metadataFile)) as Record<string, unknown>;
    expect(after.noteMtimes).toBeDefined();
  });
});

describe("frontmatter-only notes (alias hubs)", () => {
  it("emits a stub chunk so aliases and filename are retrievable", async () => {
    const adapter = new InMemoryVaultAdapter("v", {
      "Hubs/Quartzine Protocol.md":
        "---\naliases:\n  - QZP\n  - The Quartzine Spec\ntags: [protocol]\n---\n",
      "Notes/empty.md": "",
      "Notes/plain.md": "---\ntitle: no tags no aliases\n---\n",
    });
    const scanner = new VaultScanner(adapter);
    const notes = await scanner.scan(scanConfig());
    const mgr = new IndexManager(adapter, PATHS, { clock: nextClock });
    const index = await mgr.build(notes);

    const hub = index.chunks.filter((c) => c.notePath === "Hubs/Quartzine Protocol.md");
    expect(hub.length).toBe(1);
    expect(hub[0].text).toContain("Quartzine Protocol");
    expect(hub[0].text).toContain("Aliases: QZP, The Quartzine Spec");
    expect(hub[0].aliases).toEqual(["QZP", "The Quartzine Spec"]);
    expect(hub[0].startLine).toBe(0);
    expect(hub[0].endLine).toBeGreaterThanOrEqual(hub[0].startLine);

    // Truly empty notes and metadata-free frontmatter stay unindexed.
    expect(index.chunks.some((c) => c.notePath === "Notes/empty.md")).toBe(false);
    expect(index.chunks.some((c) => c.notePath === "Notes/plain.md")).toBe(false);
  });
});
