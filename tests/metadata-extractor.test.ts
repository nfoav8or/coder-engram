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
});
