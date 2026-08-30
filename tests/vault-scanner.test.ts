import { describe, it, expect } from "vitest";
import { VaultScanner } from "../src/indexing/vault-scanner";
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

// No production caller needs `matchesPathPattern` as its own entry point, so it
// is exercised here through the public `isPathEligible` surface instead — a
// path matching an excludedPathPatterns entry is exactly a path ruled ineligible.
describe("excludedPathPatterns matching (via isPathEligible)", () => {
  const scanner = new VaultScanner(new InMemoryVaultAdapter("v", {}));
  it("matches substrings case-insensitively", () => {
    expect(scanner.isPathEligible("Private/Secret.md", config({ excludedPathPatterns: ["secret"] }))).toBe(false);
  });
  it("still excludes when a pattern is too complex to compile safely", () => {
    // Patterns past the wildcard/length cap cannot be handed to a RegExp — the
    // `[^/]*` and `.*` the glob compiles to backtrack catastrophically when
    // combined. The fallback used to strip the wildcards and test `includes`
    // on the remainder, which turned `Private/**/*.md` into the literal
    // `Private/.md`: a string essentially no path contains, so the exclusion
    // matched NOTHING and the notes it was meant to hide were indexed and
    // reachable over the MCP server, silently. A privacy control may be wrong
    // by excluding too much; it may not be wrong by excluding nothing.
    const many = `Private/${"*".repeat(13)}.md`;
    expect(scanner.isPathEligible("Private/2026/08/secret.md", config({ excludedPathPatterns: [many] }))).toBe(false);

    // Over the length cap, same fallback, same requirement.
    const long = `Private/*${"b".repeat(300)}*.md`;
    expect(scanner.isPathEligible(`Private/${"b".repeat(300)}.md`, config({ excludedPathPatterns: [long] }))).toBe(false);

    // The fallback is a superset of the glob, not a wildcard: an unrelated
    // path must still be eligible, or a complex pattern would empty the index.
    expect(scanner.isPathEligible("Notes/ok.md", config({ excludedPathPatterns: [many] }))).toBe(true);
    expect(scanner.isPathEligible("Private/2026/08/secret.md", config({ excludedPathPatterns: [`Archive/${"*".repeat(13)}.md`] }))).toBe(true);
  });

  it("matches globs", () => {
    expect(scanner.isPathEligible("a/b/secret.md", config({ excludedPathPatterns: ["**/secret.md"] }))).toBe(false);
    // * does not cross '/'
    expect(scanner.isPathEligible("a/notes.md", config({ excludedPathPatterns: ["*.md"] }))).toBe(true);
    expect(scanner.isPathEligible("notes.md", config({ excludedPathPatterns: ["*.md"] }))).toBe(false);
  });
});

describe("a blank folder entry must not exclude the whole vault", () => {
  // `isUnderFolderFolded` treats an empty folder key as matching EVERY path, so
  // one blank entry in excludedFolders silently indexed nothing at all — the
  // plugin's core feature off, with no error to say why. The include list
  // already filtered blanks; the exclude list did not. Reachable from a
  // hand-edited data.json or a restored settings backup, since the settings
  // migration used to preserve blanks.
  const scanner = new VaultScanner(new InMemoryVaultAdapter("v", {}));
  for (const blank of ["", "   ", "/", "./"]) {
    it(`ignores ${JSON.stringify(blank)} in excludedFolders`, () => {
      expect(scanner.isPathEligible("Notes/a.md", config({ excludedFolders: [blank] }))).toBe(true);
    });
  }
  it("still excludes a real folder listed alongside a blank one", () => {
    const cfg = config({ excludedFolders: ["", "Private"] });
    expect(scanner.isPathEligible("Notes/a.md", cfg)).toBe(true);
    expect(scanner.isPathEligible("Private/s.md", cfg)).toBe(false);
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

  /**
   * The accented-tag test above uses FRONTMATTER tags, which always parsed
   * correctly — which is exactly why the inline path stayed broken through the
   * 0.9.9 Unicode-form fix. Inline tags were harvested with an ASCII-only
   * class, so `#privé` became `priv` and `#личное` became nothing, and the
   * exclusion silently failed open: a note the user marked to keep away from
   * the agent was indexed and served anyway.
   */
  it("excludes a note carrying an INLINE tag written in any script", async () => {
    const adapter = new InMemoryVaultAdapter("v", {
      "Notes/ascii.md": "# A\n\nsalary #private\n",
      "Notes/accented.md": "# B\n\nsalary #privé\n",
      "Notes/decomposed.md": `# C\n\nsalary #${"privé".normalize("NFD")}\n`,
      "Notes/russian.md": "# D\n\nsalary #личное\n",
      "Notes/open.md": "# Open\n\npublic.\n",
    });
    const scanned = await new VaultScanner(adapter).scan(
      config({ excludedTags: ["private", "privé".normalize("NFC"), "личное"] }),
    );
    expect(scanned.map((n) => n.path)).toEqual(["Notes/open.md"]);
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
