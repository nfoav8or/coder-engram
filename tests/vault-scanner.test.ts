import { describe, it, expect } from "vitest";
import { VaultScanner, matchesPathPattern } from "../src/indexing/vault-scanner";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";

function config(overrides = {}) {
  return {
    includedFolders: [],
    excludedFolders: [],
    excludedTags: [],
    excludedPathPatterns: [],
    ...overrides,
  };
}

describe("matchesPathPattern", () => {
  it("matches substrings case-insensitively", () => {
    expect(matchesPathPattern("Private/Secret.md", "secret")).toBe(true);
  });
  it("matches globs", () => {
    expect(matchesPathPattern("a/b/secret.md", "**/secret.md")).toBe(true);
    expect(matchesPathPattern("a/notes.md", "*.md")).toBe(false); // * does not cross '/'
    expect(matchesPathPattern("notes.md", "*.md")).toBe(true);
  });
});

describe("VaultScanner filtering", () => {
  const adapter = new InMemoryVaultAdapter("v", {
    "Notes/a.md": "# A\ncontent",
    "Private/secret.md": "# Secret\nhidden",
    "Work/b.md": "---\ntags: [confidential]\n---\n# B\nbody",
    "Archive/old.md": "# Old\nstale",
  });

  it("indexes everything by default", async () => {
    const scanner = new VaultScanner(adapter);
    const notes = await scanner.scan(config());
    expect(notes.map((n) => n.path).sort()).toEqual([
      "Archive/old.md",
      "Notes/a.md",
      "Private/secret.md",
      "Work/b.md",
    ]);
  });

  it("honors an included-folder allowlist", async () => {
    const notes = await new VaultScanner(adapter).scan(config({ includedFolders: ["Notes"] }));
    expect(notes.map((n) => n.path)).toEqual(["Notes/a.md"]);
  });

  it("honors an excluded folder", async () => {
    const notes = await new VaultScanner(adapter).scan(config({ excludedFolders: ["Private"] }));
    expect(notes.map((n) => n.path)).not.toContain("Private/secret.md");
  });

  it("honors an excluded path pattern", async () => {
    const notes = await new VaultScanner(adapter).scan(config({ excludedPathPatterns: ["secret"] }));
    expect(notes.map((n) => n.path)).not.toContain("Private/secret.md");
  });

  it("honors an excluded tag", async () => {
    const notes = await new VaultScanner(adapter).scan(config({ excludedTags: ["confidential"] }));
    expect(notes.map((n) => n.path)).not.toContain("Work/b.md");
  });
});

describe("VaultScanner skip-unchanged fast path", () => {
  function countingAdapter(seed: Record<string, string>) {
    const adapter = new InMemoryVaultAdapter("v", seed);
    const counter = { reads: 0 };
    const orig = adapter.read.bind(adapter);
    adapter.read = async (p: string) => {
      counter.reads++;
      return orig(p);
    };
    return { adapter, counter };
  }

  it("returns content-less stubs for known-mtime notes without touching disk", async () => {
    const { adapter, counter } = countingAdapter({
      "Notes/a.md": "# A\nalpha",
      "Notes/b.md": "# B\nbeta",
    });
    const scanner = new VaultScanner(adapter);
    const first = await scanner.scan(config());
    const mtimes = new Map(first.map((n) => [n.path, n.mtime]));

    adapter.touch("Notes/b.md", "# B\nchanged");
    counter.reads = 0;
    const second = await scanner.scan(config(), mtimes);
    expect(counter.reads).toBe(1); // only the changed note was read

    const stub = second.find((n) => n.path === "Notes/a.md");
    expect(stub && "unchanged" in stub && stub.unchanged).toBe(true);
    const fresh = second.find((n) => n.path === "Notes/b.md");
    expect(fresh && "content" in fresh && fresh.content).toContain("changed");
  });

  it("still reads and re-checks a note absent from the map (e.g. previously tag-excluded)", async () => {
    const { adapter, counter } = countingAdapter({
      "Notes/a.md": "# A\nalpha",
      "Work/b.md": "---\ntags: [confidential]\n---\n# B\nbody",
    });
    const scanner = new VaultScanner(adapter);
    const cfg = config({ excludedTags: ["confidential"] });
    const first = await scanner.scan(cfg);
    expect(first.map((n) => n.path)).not.toContain("Work/b.md");
    const mtimes = new Map(first.map((n) => [n.path, n.mtime]));

    counter.reads = 0;
    const second = await scanner.scan(cfg, mtimes);
    // The excluded note isn't in the map, so it is read and re-checked —
    // exclusion is enforced by verdict, never assumed by absence.
    expect(counter.reads).toBe(1);
    expect(second.map((n) => n.path)).not.toContain("Work/b.md");
  });
});
