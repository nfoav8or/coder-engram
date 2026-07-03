import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "../src/core/markdown-chunker";

describe("chunkMarkdown", () => {
  it("splits on headings and records the heading + breadcrumb", () => {
    const md = [
      "# Top",
      "intro",
      "## Section A",
      "content a",
      "## Section B",
      "content b",
    ].join("\n");
    const chunks = chunkMarkdown(md);
    const headings = chunks.map((c) => c.heading);
    expect(headings).toEqual(["Top", "Section A", "Section B"]);
    const sectionA = chunks.find((c) => c.heading === "Section A")!;
    expect(sectionA.headingPath).toEqual(["Top"]);
    expect(sectionA.text).toContain("content a");
  });

  it("captures preamble before the first heading", () => {
    const md = "preamble line\n\n# First\nbody";
    const chunks = chunkMarkdown(md);
    expect(chunks[0].heading).toBe("");
    expect(chunks[0].text).toContain("preamble line");
  });

  it("does not treat # inside a fenced code block as a heading", () => {
    const md = ["# Real", "```", "# not a heading", "code", "```", "after"].join("\n");
    const chunks = chunkMarkdown(md);
    expect(chunks.map((c) => c.heading)).toEqual(["Real"]);
    expect(chunks[0].text).toContain("# not a heading");
  });

  it("splits a long section into multiple windowed chunks", () => {
    const para = "word ".repeat(80).trim(); // ~400 chars
    const md = ["# Big", para, "", para, "", para, "", para].join("\n");
    const chunks = chunkMarkdown(md, { maxChars: 500, overlapChars: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.heading).toBe("Big");
  });

  it("tracks line spans in the original document", () => {
    const md = ["# A", "x", "## B", "y"].join("\n");
    const chunks = chunkMarkdown(md);
    const b = chunks.find((c) => c.heading === "B")!;
    expect(b.startLine).toBe(2);
    expect(b.endLine).toBe(3);
  });

  it("does not emit a header-only chunk when the first paragraph overflows", () => {
    const md = "# H\n\n" + "x".repeat(1500);
    const chunks = chunkMarkdown(md, { maxChars: 1200 });
    // No chunk should be just the heading with no body.
    expect(chunks.every((c) => c.text.replace(/^#.*$/m, "").trim().length > 0)).toBe(true);
    expect(chunks[0].text).toContain("x");
  });

  it("skips frontmatter when bodyStartLine is provided", () => {
    const md = ["---", "tags: x", "---", "# Body", "text"].join("\n");
    const chunks = chunkMarkdown(md, { bodyStartLine: 3 });
    expect(chunks.map((c) => c.heading)).toEqual(["Body"]);
  });
});
