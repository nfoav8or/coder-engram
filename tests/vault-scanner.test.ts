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
