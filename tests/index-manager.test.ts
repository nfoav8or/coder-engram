import { describe, it, expect } from "vitest";
import { IndexManager, IndexPaths } from "../src/indexing/index-manager";
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
    const index = mgr.build(notes);
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
    mgr.build(notes);
    await mgr.persist();

    const reloaded = new IndexManager(adapter, PATHS, { clock: nextClock });
    const loaded = await reloaded.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.chunks.length).toBe(mgr.getChunks().length);
  });

  it("returns null when loading a missing index", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const mgr = new IndexManager(adapter, PATHS, { clock: nextClock });
    expect(await mgr.load()).toBeNull();
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
    mgr.build(await scanner.scan(scanConfig()));

    // Modify a.md (bumps mtime), delete b.md, add c.md.
    adapter.touch("Notes/a.md", "# Alpha\nCHANGED content");
    // Simulate deletion by constructing a fresh adapter without b.
    const adapter2 = new InMemoryVaultAdapter("v", {
      "Notes/a.md": "# Alpha\nCHANGED content",
      "Notes/c.md": "# Gamma\nnew note",
    });
    const mgr2 = new IndexManager(adapter2, PATHS, { clock: nextClock });
    mgr2.build(await scanner.scan(scanConfig())); // seed with a+b (old adapter)

    const result = mgr2.refresh(await new VaultScanner(adapter2).scan(scanConfig()));
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
    mgr.build(notes);
    const result = mgr.refresh(notes); // same notes, same mtime
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
    mgr.build(notes);
    const before = mgr.getChunks();
    mgr.refresh(notes);
    // Same ARRAY OBJECT, not just equal contents: retrieval memoizes corpus
    // stats by chunks-array identity, so swapping in an equal-content array
    // would silently re-pay the full stats build on the next query.
    expect(mgr.getChunks()).toBe(before);

    adapter.touch("Notes/a.md", "# Alpha\nCHANGED");
    mgr.refresh(await scanner.scan(scanConfig()));
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
    mgr.build(await scanner.scan(scanConfig()));
    const before = mgr.getChunks();

    const result = mgr.refresh(await scanner.scan(scanConfig()));
    expect(result).toEqual({ added: 0, updated: 0, removed: 0, unchanged: 2 });
    expect(mgr.getChunks()).toBe(before);

    // An empty note gaining content is an update and becomes indexed.
    adapter.touch("Notes/empty.md", "# Filled\nnow has content");
    const result2 = mgr.refresh(await scanner.scan(scanConfig()));
    expect(result2.updated).toBe(1);
    expect(result2.added).toBe(0);
    expect(mgr.getChunks().map((c) => c.notePath)).toContain("Notes/empty.md");
  });
});
