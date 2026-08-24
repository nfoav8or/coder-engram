import { describe, it, expect } from "vitest";
import { extractMetadata } from "../src/core/metadata-extractor";

describe("extractMetadata", () => {
  it("parses inline-list frontmatter tags and aliases", () => {
    const md = [
      "---",
      "tags: [alpha, beta]",
      "aliases: [Foo, Bar]",
      "title: My Note",
      "---",
      "# Heading",
      "body",
    ].join("\n");
    const meta = extractMetadata(md);
    expect(meta.tags).toEqual(expect.arrayContaining(["alpha", "beta"]));
    expect(meta.aliases).toEqual(expect.arrayContaining(["Foo", "Bar"]));
    expect(meta.title).toBe("My Note");
    expect(meta.bodyStartLine).toBe(5);
  });

  it("parses block-list frontmatter", () => {
    const md = ["---", "tags:", "  - one", "  - two", "---", "content"].join("\n");
    const meta = extractMetadata(md);
    expect(meta.tags).toEqual(expect.arrayContaining(["one", "two"]));
  });

  it("collects inline hashtags from the body", () => {
    const md = "Some text #project/sub and #idea here";
    const meta = extractMetadata(md);
    expect(meta.tags).toEqual(expect.arrayContaining(["project/sub", "idea"]));
  });

  it("ignores purely-numeric hashtags", () => {
    const md = "issue #123 not a tag";
    const meta = extractMetadata(md);
    expect(meta.tags).not.toContain("123");
  });

  it("extracts wikilinks and relative markdown links, excluding urls", () => {
    const md = "See [[Other Note]] and [doc](docs/a.md) but not [site](https://x.com)";
    const meta = extractMetadata(md);
    expect(meta.links).toEqual(expect.arrayContaining(["Other Note", "docs/a.md"]));
    expect(meta.links).not.toContain("https://x.com");
  });

  it("falls back to first H1 for the title", () => {
    const md = "# Real Title\n\nbody";
    expect(extractMetadata(md).title).toBe("Real Title");
  });

  it("does not harvest tags or links from fenced code blocks", () => {
    const md = [
      "Real #keeper tag here.",
      "```css",
      "color: #ff0000;",
      "```",
      "```c",
      "#include <stdio.h>",
      "```",
      "And a [[RealLink]].",
    ].join("\n");
    const meta = extractMetadata(md);
    expect(meta.tags).toContain("keeper");
    expect(meta.tags).not.toContain("ff0000");
    expect(meta.tags).not.toContain("include");
    expect(meta.links).toContain("RealLink");
  });

  it("handles a note with no frontmatter", () => {
    const meta = extractMetadata("just body text");
    expect(meta.bodyStartLine).toBe(0);
    expect(meta.tags).toEqual([]);
  });

  // Tag extraction is a PRIVACY control: `excludedTags` keeps a note out of
  // the index, and a tag the parser misses means the note is indexed and
  // served over the local server despite the user having excluded it. Every
  // case below failed open before — the same shape as the 0.10.4 and 0.9.9
  // bugs, which is why they are pinned individually rather than in one blob.
  describe("inline tags after punctuation (fail-open regressions)", () => {
    const cases: [string, string][] = [
      ["bold emphasis", "**#private**"],
      ["comma-separated list", "urgent,#private,todo"],
      ["double-quoted", '"#private" note'],
      ["single-quoted", "'#private' note"],
      ["after a colon", "status:#private"],
      ["after a hyphen", "tagged -#private"],
      ["after a bracket", "[#private]"],
      ["start of string", "#private"],
      ["after whitespace", "some #private text"],
      ["after a paren", "see (#private) here"],
    ];
    for (const [name, text] of cases) {
      it(`finds a tag ${name}`, () => {
        expect(extractMetadata(text).tags).toContain("private");
      });
    }
  });

  describe("inline-tag shapes that must NOT read as tags", () => {
    it("ignores a URL fragment", () => {
      expect(extractMetadata("see https://example.com/page#section now").tags).toEqual([]);
    });

    it("ignores a markdown anchor link target", () => {
      // Regression: `(` used to be an allowed prefix, so `](#x)` matched.
      expect(extractMetadata("see [details](#private) here").tags).toEqual([]);
    });

    it("ignores a `#` that follows a word character", () => {
      expect(extractMetadata("written in C#Sharp today").tags).toEqual([]);
    });

    it("ignores a purely numeric tag", () => {
      expect(extractMetadata("issue #123 filed").tags).toEqual([]);
    });
  });

  it("records the known limit: underscore emphasis is ambiguous with the tag grammar", () => {
    // `_` is a legal tag CHARACTER, so `__#private__` cannot be read as an
    // emphasized `#private` without also breaking `#private__`, a legitimate
    // tag name. Asterisk emphasis — the common form — works and is pinned
    // above. Documented rather than silently unsupported: if this ever needs
    // to change, the trade-off is here rather than rediscovered.
    expect(extractMetadata("__#private__").tags).toEqual([]);
  });

  it("still honors frontmatter tags when the block is never terminated", () => {
    // A truncated write / sync conflict leaves no closing `---`. The tags are
    // the note's only exclusion marker and carry no `#`, so dropping the block
    // meant the inline pattern had nothing to find and the note was indexed.
    const meta = extractMetadata("---\ntags:\n  - private\ntitle: Secret\nbody text\n");
    expect(meta.tags).toContain("private");
    // Content is NOT hidden: without a closing fence the whole file is body,
    // exactly as before, so this cannot cause a note to lose its text.
    expect(meta.bodyStartLine).toBe(0);
  });

  it("still honors an unterminated inline frontmatter tag list", () => {
    expect(extractMetadata("---\ntags: private, secret\nbody text\n").tags).toEqual(
      expect.arrayContaining(["private", "secret"]),
    );
  });
});

describe("link extraction (linear walkers)", () => {
  // The regexes the walkers replaced — kept here as the behavioral oracle.
  const WIKILINK = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  const MD_LINK = /\[[^\]]*\]\(([^)]+)\)/g;

  function oracleLinks(prose: string): string[] {
    const links: string[] = [];
    for (const m of prose.matchAll(WIKILINK)) links.push(m[1].trim());
    for (const m of prose.matchAll(MD_LINK)) links.push(m[1].trim());
    return Array.from(new Set(links.filter((l) => l.length > 0)));
  }

  const CASES = [
    "plain [[Simple]] link",
    "[[With|Alias]] and [[With#Heading]] and [[A#h|both]]",
    "[[nested [brackets]] survive",
    "reject [[a]b]] then accept [[c]]",
    "[[x]] [[a]b]] [[y]]",
    "[[[[double open]] edge",
    "[[]] empty and [[#heading only]] and [[|alias only]]",
    "md [text](target.md) and ![img](pic.png)",
    "md with [brackets [inside] text](t.md) mixed",
    "[a](x) [b](y) back to back",
    "[t]() empty url then [u](real)",
    "](orphan) then [ok](fine)",
    "[unclosed](never ends",
    "[a]((parens).md) inner",
    "text ]] before [[Valid]] after",
    "[[a]][[b]] adjacent",
    "[[trail]]] extra bracket",
  ];

  it("matches the regex oracle on tricky inputs", () => {
    for (const prose of CASES) {
      expect(extractMetadata(prose).links, `input: ${prose}`).toEqual(
        oracleLinks(prose).filter((l) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(l)),
      );
    }
  });

  it("stays linear on hostile bracket floods (was quadratic: ~13s at 100 KB)", () => {
    const floods = [
      "[".repeat(2_000_000),
      "]".repeat(2_000_000),
      "[a](".repeat(400_000),
      "[[x".repeat(500_000),
      "](".repeat(700_000),
      // Same floods ending in a real terminator: every candidate now finds a
      // far close/paren, which is quadratic without the memoized terminator.
      "[[#".repeat(500_000) + "]]",
      "[[".repeat(700_000) + "]x]]",
      "](".repeat(700_000) + ")",
      "[a](".repeat(400_000) + ")",
    ];
    const start = Date.now();
    for (const flood of floods) extractMetadata(flood);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  /**
   * Inline tags used an ASCII-only class, which did not merely skip a
   * non-Latin tag — it truncated one. `#privé` was harvested as `priv` and
   * `#личное` as nothing at all, while the same tags in frontmatter parsed
   * correctly. Tag exclusion is a privacy control, so a tag the extractor
   * cannot spell is an exclusion that fails open.
   */
  it("harvests an inline tag written in any script", () => {
    expect(extractMetadata("body #privé more").tags).toEqual(["privé"]);
    expect(extractMetadata("body #persönlich more").tags).toEqual(["persönlich"]);
    expect(extractMetadata("body #личное more").tags).toEqual(["личное"]);
    expect(extractMetadata("body #個人 more").tags).toEqual(["個人"]);
    expect(extractMetadata("body #travail/privé more").tags).toEqual(["travail/privé"]);
  });

  it("keeps a decomposed accent inside the tag rather than cutting at it", () => {
    // A combining mark is not a letter, so without \\p{M} the tag stopped at the
    // accent and became a different word. The scanner folds to NFC before
    // comparing, so capturing it whole is what lets both encodings match one
    // exclusion.
    const decomposed = "privé".normalize("NFD");
    expect(decomposed).not.toBe("privé".normalize("NFC"));
    const tags = extractMetadata(`body #${decomposed} more`).tags;
    expect(tags).toHaveLength(1);
    expect(tags[0].normalize("NFC")).toBe("privé".normalize("NFC"));
  });

  it("still refuses a bare hash and keeps ASCII tags unchanged", () => {
    expect(extractMetadata("body # not-a-tag").tags).toEqual([]);
    expect(extractMetadata("body #private more").tags).toEqual(["private"]);
    expect(extractMetadata("body #work/private more").tags).toEqual(["work/private"]);
  });
});
