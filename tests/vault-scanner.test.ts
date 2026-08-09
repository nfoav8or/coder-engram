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

  it("excludes a folder the user spelled in a different case", async () => {
    // The tag and pattern filters beside this one already fold case, so an
    // exact-case folder match failed in the one direction that is unsafe: the
    // note stays indexed, and every read tool will then serve it, with nothing
    // to tell the user their exclusion did nothing.
    for (const spelling of ["private", "PRIVATE", "pRiVaTe"]) {
      const notes = await new VaultScanner(adapter).scan(config({ excludedFolders: [spelling] }));
      expect(notes.map((n) => n.path)).not.toContain("Private/secret.md");
    }
  });

  it("matches an included folder case-insensitively too", async () => {
    const notes = await new VaultScanner(adapter).scan(config({ includedFolders: ["notes"] }));
    expect(notes.map((n) => n.path)).toEqual(["Notes/a.md"]);
  });

  it("excludes an accented folder whichever Unicode form each side is in", async () => {
    // macOS stores an accented filename DECOMPOSED; the same name typed into
    // the settings box arrives COMPOSED. One name to a person and to the
    // filesystem, two different strings to a comparison — so this failed in
    // the unsafe direction, exactly like matching case exactly used to.
    const nfc = "Privé"; // é as one codepoint
    const nfd = "Privé"; // e + combining acute
    expect(nfc).not.toBe(nfd);
    for (const [onDisk, typed] of [
      [nfd, nfc],
      [nfc, nfd],
    ]) {
      const vault = new InMemoryVaultAdapter("v", {
        [`${onDisk}/secret.md`]: "# Secret\n\nsalary.\n",
        "Public/open.md": "# Open\n\npublic.\n",
      });
      const notes = await new VaultScanner(vault).scan(config({ excludedFolders: [typed] }));
      expect(notes.map((n) => n.path)).toEqual(["Public/open.md"]);
    }
  });

  it("excludes an accented tag and path pattern across Unicode forms too", async () => {
    const nfc = "privé";
    const nfd = "privé";
    const tagged = new InMemoryVaultAdapter("v", {
      "Notes/secret.md": `---\ntags: [${nfd}]\n---\n\n# Secret\n\nsalary.\n`,
      "Notes/open.md": "# Open\n\npublic.\n",
    });
    const byTag = await new VaultScanner(tagged).scan(config({ excludedTags: [nfc] }));
    expect(byTag.map((n) => n.path)).toEqual(["Notes/open.md"]);

    const named = new InMemoryVaultAdapter("v", {
      [`Notes/${nfd}-notes.md`]: "# Secret\n\nsalary.\n",
      "Notes/open.md": "# Open\n\npublic.\n",
    });
    const byPattern = await new VaultScanner(named).scan(config({ excludedPathPatterns: [nfc] }));
    expect(byPattern.map((n) => n.path)).toEqual(["Notes/open.md"]);
  });

  it("excludes a folder written with a leading ./ like every other path here", async () => {
    // normalizeVaultRelativePath drops "." segments everywhere else, so a
    // folder setting that keeps them is the one place "./Private" names
    // nothing.
    const notes = await new VaultScanner(adapter).scan(config({ excludedFolders: ["./Private"] }));
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
