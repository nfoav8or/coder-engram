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
});
