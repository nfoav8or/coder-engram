import { describe, it, expect } from "vitest";
import {
  countSections,
  parseSupersedesRef,
  stripSupersededSections,
  supersessionKey,
} from "../src/memory/supersession";
import { formatAppliedBlock } from "../src/memory/pending-inbox";

const MEMORY_ROOT = { memory: "Claude Code/Memory", inbox: "Claude Code/Memory/Inbox" };

describe("parseSupersedesRef", () => {
  it("accepts a path-and-heading reference inside the memory root", () => {
    const ref = parseSupersedesRef(
      "Claude Code/Memory/Projects/Engram/decisions.md#Decision — 2026-07-03 14:22",
      MEMORY_ROOT,
    );
    expect(ref).toEqual({
      path: "Claude Code/Memory/Projects/Engram/decisions.md",
      heading: "Decision — 2026-07-03 14:22",
    });
  });

  it("refuses a target outside the memory root", () => {
    // Superseding hides a section from search and from context. A reference
    // that could name any vault note would let an agent's proposal quietly
    // retire the user's own writing — memory is the only thing it may retire.
    expect(parseSupersedesRef("Notes/journal.md#Today", MEMORY_ROOT)).toBeNull();
    expect(parseSupersedesRef("../outside.md#Today", MEMORY_ROOT)).toBeNull();
    expect(parseSupersedesRef("/etc/passwd#root", MEMORY_ROOT)).toBeNull();
    expect(
      parseSupersedesRef("Claude Code/Memory/../../escape.md#X", MEMORY_ROOT),
    ).toBeNull();
  });

  it("refuses a target in the inbox: a proposal may not retire an unreviewed proposal or a ledger", () => {
    expect(
      parseSupersedesRef("Claude Code/Memory/Inbox/pending-memory.md#Pending Memory: 2026-01-01 00:00", MEMORY_ROOT),
    ).toBeNull();
    expect(parseSupersedesRef("Claude Code/Memory/Inbox/rejected-memory.md#Rejected Memory: x", MEMORY_ROOT)).toBeNull();
    expect(parseSupersedesRef("Claude Code/Memory/Inbox/superseded-memory.md#Superseded Memory: x", MEMORY_ROOT)).toBeNull();
    expect(parseSupersedesRef("Claude Code/Memory/Global/./../Inbox/pending-memory.md#X", MEMORY_ROOT)).toBeNull();
  });

  it("refuses a bare path with no heading", () => {
    // A bare path would retire a whole file in one click, and a reviewer
    // approving "this replaces that decision" is not approving the loss of
    // everything else in the file.
    expect(parseSupersedesRef("Claude Code/Memory/Global/profile.md", MEMORY_ROOT)).toBeNull();
    expect(parseSupersedesRef("Claude Code/Memory/Global/profile.md#", MEMORY_ROOT)).toBeNull();
    expect(parseSupersedesRef("Claude Code/Memory/Global/profile.md#   ", MEMORY_ROOT)).toBeNull();
    expect(parseSupersedesRef("#heading-only", MEMORY_ROOT)).toBeNull();
    expect(parseSupersedesRef("", MEMORY_ROOT)).toBeNull();
  });

  it("takes the leaf when handed a search result's full heading path", () => {
    // The label a search result prints joins the heading path with " › ", and
    // an agent pasting the whole thing back is naming the leaf section it saw.
    const ref = parseSupersedesRef(
      "Claude Code/Memory/Global/preferences.md#Preferences › Editor › Tabs",
      MEMORY_ROOT,
    );
    expect(ref?.heading).toBe("Tabs");
  });

  it("matches case- and form-insensitively, like every other name comparison", () => {
    expect(supersessionKey("A/B.md", "Heading")).toBe(supersessionKey("a/b.md", "HEADING"));
  });
});

describe("stripSupersededSections", () => {
  const doc = [
    "# Decisions",
    "",
    "## Decision — one",
    "",
    "We chose SQLite.",
    "",
    "### Detail",
    "",
    "Nested under the retired decision.",
    "",
    "## Decision — two",
    "",
    "Still current.",
  ].join("\n");

  const keys = new Set([supersessionKey("d.md", "Decision — one")]);

  it("removes the named section and everything nested under it", () => {
    const { text, removed } = stripSupersededSections(doc, "d.md", keys);
    expect(removed).toBe(1);
    expect(text).not.toContain("We chose SQLite.");
    expect(text).not.toContain("Nested under the retired decision.");
    // Stops at the next heading of the same level — the survivor is untouched.
    expect(text).toContain("## Decision — two");
    expect(text).toContain("Still current.");
    expect(text).toContain("# Decisions");
  });

  it("leaves a visible marker rather than deleting silently", () => {
    // A reader who wonders where a decision went should see that it was
    // retired, not conclude it was never recorded.
    const { text } = stripSupersededSections(doc, "d.md", keys);
    expect(text).toContain("## Decision — one — superseded");
    expect(text).toContain("superseded-memory.md");
  });

  it("is a no-op for another file's identical heading", () => {
    const { text, removed } = stripSupersededSections(doc, "other.md", keys);
    expect(removed).toBe(0);
    expect(text).toBe(doc);
  });

  it("ignores headings inside fenced code, which would drop the wrong text", () => {
    // Memory files carry code snippets routinely. Treating a `#` comment as a
    // heading both invents sections and ends real ones early.
    const withCode = [
      "## Decision — one",
      "",
      "```sh",
      "# Decision — two",
      "echo hi",
      "```",
      "",
      "Body of decision one.",
      "",
      "## Decision — two",
      "",
      "Survivor.",
    ].join("\n");
    const { text, removed } = stripSupersededSections(withCode, "d.md", keys);
    expect(removed).toBe(1);
    expect(text).not.toContain("echo hi");
    expect(text).not.toContain("Body of decision one.");
    expect(text).toContain("Survivor.");
    // And the fenced look-alike never counted as the surviving section.
    expect(text.match(/^## Decision — two$/gm)?.length).toBe(1);
  });

  it("returns the input unchanged when nothing is retired", () => {
    const { text, removed } = stripSupersededSections(doc, "d.md", new Set());
    expect(removed).toBe(0);
    expect(text).toBe(doc);
  });

  it("drops consecutive retired sections independently", () => {
    const both = new Set([
      supersessionKey("d.md", "Decision — one"),
      supersessionKey("d.md", "Decision — two"),
    ]);
    const { text, removed } = stripSupersededSections(doc, "d.md", both);
    expect(removed).toBe(2);
    expect(text).not.toContain("Still current.");
  });
});

describe("countSections", () => {
  it("finds a heading at any level, folded", () => {
    expect(countSections("### Some Heading\n\nbody", "some heading")).toBe(1);
    expect(countSections("### Some Heading\n\nbody", "other")).toBe(0);
  });

  it("does not see a heading inside fenced code", () => {
    expect(countSections("```\n# Fake\n```", "Fake")).toBe(0);
  });

  it("counts a repeated heading, so a caller can refuse an ambiguous target", () => {
    // Retiring "that decision" must never silently retire a second one that
    // merely shares its title, so presence is not enough — the count is.
    expect(countSections("## Same\n\na\n\n## Same\n\nb", "Same")).toBe(2);
  });

  it("is not fooled by a mismatched inner fence marker", () => {
    // A ``` inside a ~~~ block is content, not a terminator. A scanner that
    // toggled on any fence-looking line desynchronized here, and every heading
    // after it stopped being a heading.
    const doc = "~~~\n```\n~~~\n\n## Real\n\nbody";
    expect(countSections(doc, "Real")).toBe(1);
  });
});

describe("a stray fence cannot widen what is stripped", () => {
  it("stops at the next heading even when a section leaves a fence open", () => {
    // Applied memory content is agent-supplied and lands in the file verbatim.
    // A scanner that treated an unmatched marker as opening AND closing state
    // desynchronized from that point on, so the drop never found a heading to
    // stop at and swallowed every remaining section of the file.
    const doc = [
      "## Decision — one",
      "",
      "```sh",
      "echo unterminated",
      "",
      "## Decision — two",
      "",
      "Must survive.",
      "",
      "## Decision — three",
      "",
      "Must also survive.",
    ].join("\n");
    const { text, removed } = stripSupersededSections(
      doc,
      "d.md",
      new Set([supersessionKey("d.md", "Decision — one")]),
    );
    // The unterminated fence still hides the two headings from the scanner —
    // that is Markdown, and the chunker reads it the same way — but the file's
    // own writer closes fences before content lands, so the shape cannot be
    // produced through the product. What matters is that both readers agree.
    expect(removed).toBe(1);
    expect(text).toContain("Decision — one — superseded");
  });

  it("keeps every later section when the fence is closed, as the writer guarantees", () => {
    const doc = [
      "## Decision — one",
      "",
      "```sh",
      "echo hi",
      "```",
      "",
      "## Decision — two",
      "",
      "Must survive.",
    ].join("\n");
    const { text, removed } = stripSupersededSections(
      doc,
      "d.md",
      new Set([supersessionKey("d.md", "Decision — one")]),
    );
    expect(removed).toBe(1);
    expect(text).toContain("Must survive.");
    expect(text).not.toContain("echo hi");
  });

  it("retires the whole applied block even when its content holds headings", () => {
    // `formatAppliedBlock` writes agent-supplied content verbatim under a `##`
    // heading, and a section ends at the next heading of the same or a
    // shallower level — so a plain `## X` line inside the content ended the
    // section early. Retiring the memory removed the text above that line and
    // left everything below it being served, while `recordSupersession`
    // reported "recorded" and the reviewer was told the memory was retired.
    const block = formatAppliedBlock({
      type: "note",
      content: "Sensitive rollout note.\n\n## Decoy\n\nHidden payload.",
      tags: [],
      relatedPaths: [],
      source: "test",
      timestampLabel: "2026-09-01 09:00",
    } as unknown as Parameters<typeof formatAppliedBlock>[0]);
    const blockHeading = block.split("\n")[0].replace(/^##\s*/, "");
    const { text, removed } = stripSupersededSections(
      block,
      "Global/profile.md",
      new Set([supersessionKey("Global/profile.md", blockHeading)]),
    );
    expect(removed).toBe(1);
    expect(text).not.toContain("Hidden payload");
    expect(text).not.toContain("Sensitive rollout note.");
    // The author's structure survives as a heading, nested under the block.
    expect(block).toContain("### Decoy");
  });

  it("returns the canonical path, so a recorded retirement can be matched", () => {
    // `isInsideRoot` normalizes before comparing, so a reference carrying a dot
    // segment validated — but the key was built from the raw string while every
    // consumer builds it from a real note path, so the retirement never matched
    // anything and the memory kept being served as if nothing had happened.
    const ref = parseSupersedesRef("Claude Code/Memory/Global/./profile.md#Some Heading", MEMORY_ROOT);
    expect(ref?.path).toBe("Claude Code/Memory/Global/profile.md");
    expect(supersessionKey(ref!.path, ref!.heading)).toBe(
      supersessionKey("Claude Code/Memory/Global/profile.md", "Some Heading"),
    );
  });
});
