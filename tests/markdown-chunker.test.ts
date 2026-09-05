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

  it("does not let a shorter same-char fence inside a longer one close it early", () => {
    // CommonMark: a closing fence must be the same character and at least as
    // long as the opening one. An opening fence of 4+ backticks/tildes used to
    // remember only 3 chars, so a 3-char fence of the same type nested inside
    // closed the block early and a `#` line inside became a real heading.
    const md = [
      "# Real",
      "````",
      "```",
      "# not a heading",
      "````",
      "after",
    ].join("\n");
    const chunks = chunkMarkdown(md);
    expect(chunks.map((c) => c.heading)).toEqual(["Real"]);
    expect(chunks[0].text).toContain("```");
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

  it("assigns each window its own precise line span", () => {
    const para = "word ".repeat(80).trim(); // ~399 chars, so each para is its own window
    // lines: 0:# Big  1:para  2:""  3:para  4:""  5:para  6:""  7:para
    const md = ["# Big", para, "", para, "", para, "", para].join("\n");
    const chunks = chunkMarkdown(md, { maxChars: 500, overlapChars: 50 });
    expect(chunks.length).toBe(4);
    // First window opens at the heading line and ends at its body paragraph.
    expect(chunks[0].startLine).toBe(0);
    expect(chunks[0].endLine).toBe(1);
    // Later windows report the line of the body paragraph they contain.
    expect(chunks.map((c) => c.startLine)).toEqual([0, 3, 5, 7]);
    expect(chunks.map((c) => c.endLine)).toEqual([1, 3, 5, 7]);
    // Text is unchanged: every window still carries the heading breadcrumb.
    for (const c of chunks) expect(c.text.startsWith("# Big")).toBe(true);
  });

  it("spans all paragraphs a window contains, first paragraph to last", () => {
    const p = "alpha beta gamma delta"; // 22 chars; two fit per 60-char window
    // lines: 0:# H  1:p  2:""  3:p  4:""  5:p  6:""  7:p
    const md = ["# H", p, "", p, "", p, "", p].join("\n");
    const chunks = chunkMarkdown(md, { maxChars: 60, overlapChars: 0 });
    expect(chunks.length).toBe(2);
    expect(chunks[0].startLine).toBe(0); // heading
    expect(chunks[0].endLine).toBe(3); // through the second paragraph
    expect(chunks[1].startLine).toBe(5); // third paragraph
    expect(chunks[1].endLine).toBe(7); // through the fourth
  });

  it("does not inflate a window's line span with a trailing whitespace-only line", () => {
    const para = "word ".repeat(80).trim();
    // A stray space line ends the body; bodyText.trim() drops it, so the last
    // window must end at paraB's line (3), not the whitespace line (4).
    // lines: 0:# Big  1:paraA  2:""  3:paraB  4:"   "
    const md = ["# Big", para, "", para, "   "].join("\n");
    const chunks = chunkMarkdown(md, { maxChars: 500, overlapChars: 0 });
    expect(chunks.length).toBe(2);
    expect(chunks[1].startLine).toBe(3);
    expect(chunks[1].endLine).toBe(3);
  });

  it("tracks per-window line spans for a windowed preamble (no heading)", () => {
    const para = "word ".repeat(80).trim();
    // lines: 0:para  1:""  2:para  (no heading -> bodyOffset is the section start)
    const md = [para, "", para].join("\n");
    const chunks = chunkMarkdown(md, { maxChars: 500, overlapChars: 50 });
    expect(chunks.length).toBe(2);
    expect(chunks[0].startLine).toBe(0);
    expect(chunks[0].endLine).toBe(0);
    expect(chunks[1].startLine).toBe(2);
    expect(chunks[1].endLine).toBe(2);
  });

  it("does not emit a header-only chunk when the first paragraph overflows", () => {
    const md = "# H\n\n" + "x".repeat(1500);
    const chunks = chunkMarkdown(md, { maxChars: 1200 });
    // No chunk should be just the heading with no body.
    expect(chunks.every((c) => c.text.replace(/^#.*$/m, "").trim().length > 0)).toBe(true);
    expect(chunks[0].text).toContain("x");
  });

  it("splits a paragraph that has no blank line to break on", () => {
    // Windowing splits on blank lines, so a paragraph containing none used to
    // pass through whole: a 100 KB paragraph became one 100,007-char chunk.
    const md = "# Blob\n\n" + "word ".repeat(20_000);
    const chunks = chunkMarkdown(md, { maxChars: 1200, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(50);
    expect(Math.max(...chunks.map((c) => c.text.length))).toBeLessThanOrEqual(1200);
    // Pieces break at whitespace, so no chunk starts or ends mid-word. (Tested
    // without overlap: the carry is a raw char slice and may start mid-word by
    // design — that predates this split and is unchanged by it.)
    const bodies = chunks.map((c) => c.text.replace(/^# Blob\n\n/, ""));
    expect(bodies.every((b) => /^word(\s+word)*\s*$/.test(b))).toBe(true);
  });

  it("hard-splits a single token with no whitespace to break on", () => {
    // A base64 blob offers no boundary at all; the budget must still hold.
    const md = "# Token\n\n" + "x".repeat(10_000);
    const chunks = chunkMarkdown(md, { maxChars: 1200, overlapChars: 0 });
    expect(Math.max(...chunks.map((c) => c.text.length))).toBeLessThanOrEqual(1200);
    // Nothing is dropped: every x survives across the pieces.
    const total = chunks.map((c) => c.text.replace(/^# Token\s*/, "")).join("").replace(/\s/g, "").length;
    expect(total).toBe(10_000);
  });

  it("keeps precise line spans for normal paragraphs beside an oversized one", () => {
    const md = ["# H", "", "first para", "", "y".repeat(3_000), "", "last para"].join("\n");
    const chunks = chunkMarkdown(md, { maxChars: 1200, overlapChars: 0 });
    // The short first paragraph still reports its own lines, not the section's.
    expect(chunks[0].startLine).toBe(0);
    expect(chunks[0].endLine).toBe(2);
    // Pieces of the oversized paragraph carry its exact span — it is one line,
    // so every piece maps to line 4 rather than falling back to the section.
    expect(chunks[1].startLine).toBe(4);
    expect(chunks[1].endLine).toBe(4);
    // The final window holds the paragraph's tail plus "last para", so its span
    // legitimately covers both.
    expect(chunks.at(-1)!.endLine).toBe(6);
  });

  it("skips frontmatter when bodyStartLine is provided", () => {
    const md = ["---", "tags: x", "---", "# Body", "text"].join("\n");
    const chunks = chunkMarkdown(md, { bodyStartLine: 3 });
    expect(chunks.map((c) => c.heading)).toEqual(["Body"]);
  });

  it("finds the first heading behind a UTF-8 BOM", () => {
    // Same root cause as the frontmatter case: `^#` missed on line 1, so the
    // note's first heading was lost and its chunk had an empty breadcrumb.
    const withBom = chunkMarkdown("\uFEFF# Title\nbody text here");
    const plain = chunkMarkdown("# Title\nbody text here");
    expect(withBom.map((c) => c.heading)).toEqual(["Title"]);
    // And no line index shifts.
    expect(withBom.map((c) => [c.startLine, c.endLine])).toEqual(
      plain.map((c) => [c.startLine, c.endLine]),
    );
  });

  describe("a trailing newline does not extend the last chunk's span", () => {
    // `split(/\r?\n/)` yields a phantom "" for a file ending in a newline —
    // which is how files normally end. A section small enough to fit one chunk
    // (most notes) returns its span unwindowed, so that phantom used to land in
    // the last chunk's endLine, and "open at line" / get_note_context pointed
    // one line past the content.
    it("agrees with the same content written without the trailing newline", () => {
      const withNewline = chunkMarkdown("# Heading\nSome body text\n");
      const without = chunkMarkdown("# Heading\nSome body text");
      expect(withNewline.map((c) => [c.startLine, c.endLine])).toEqual(
        without.map((c) => [c.startLine, c.endLine]),
      );
    });

    it("ends the last chunk on the last real line", () => {
      // Two real lines: indices 0 and 1.
      const [chunk] = chunkMarkdown("# Heading\nSome body text\n");
      expect(chunk.endLine).toBe(1);
    });

    it("is correct for a multi-section note", () => {
      const chunks = chunkMarkdown("# A\nbody a\n# B\nbody b\n");
      expect(chunks.at(-1)!.endLine).toBe(3);
    });

    it("keeps a deliberate trailing blank line that is not the split artifact", () => {
      // "a\n\n" is a real blank line (index 1) plus the artifact (index 2).
      const [chunk] = chunkMarkdown("body\n\n");
      expect(chunk.endLine).toBe(1);
    });

    it("handles CRLF endings the same way", () => {
      const [chunk] = chunkMarkdown("# Heading\r\nSome body text\r\n");
      expect(chunk.endLine).toBe(1);
    });

    it("keeps words intact when overlap would consume the whole window", () => {
      // Nothing enforced `overlapChars < maxChars`, so the two together drove
      // `pieceLimit` to its floor of 1 and every paragraph was hard-sliced one
      // character per chunk. The shipped app never passes `ChunkOptions`
      // (`IndexManager` uses the defaults), so this was a precondition of the
      // exported function rather than a live defect.
      const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
      const chunks = chunkMarkdown(text, { maxChars: 40, overlapChars: 40 });
      // Every piece is whole words, not single characters.
      for (const c of chunks) {
        expect(c.text.length, `shredded: ${JSON.stringify(c.text)}`).toBeGreaterThan(1);
      }
      expect(chunks.some((c) => c.text.includes("alpha"))).toBe(true);
      // An overlap far larger than the window is clamped, not honoured.
      const wide = chunkMarkdown(text, { maxChars: 40, overlapChars: 9999 });
      expect(wide.some((c) => c.text.includes("alpha"))).toBe(true);
      // The defaults sit well under the cap, so ordinary output is unchanged.
      expect(chunkMarkdown(text)).toEqual(chunkMarkdown(text, { maxChars: 2000, overlapChars: 150 }));
    });

    it("keeps a note findable when its heading is longer than the window", () => {
      // The live version of the defect above: with the DEFAULT options, a
      // heading line longer than `maxChars` left `pieceLimit` at its floor of
      // 1, so the body was sliced one character per chunk. 420 characters of
      // body became 360 chunks of ~2.6 KB, and no chunk held a whole word — the
      // note could not be found by searching for anything written in it. A
      // pasted line that happens to start with `#` is enough to reach this.
      const body = "widget ".repeat(60);
      const shipped = chunkMarkdown(`# ${"A".repeat(5000)}\n${body}`);
      expect(shipped.length).toBeLessThan(5);
      expect(shipped.some((c) => c.text.includes("widget"))).toBe(true);
      // An ordinary heading is untouched — the floor only binds when the
      // heading has already taken more than half the window.
      const ordinary = chunkMarkdown(`# Short\n${body}`);
      expect(ordinary).toHaveLength(1);
      expect(ordinary[0].text).toContain(body.trim());
    });
  });
});
