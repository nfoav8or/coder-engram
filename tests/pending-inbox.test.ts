import { describe, it, expect } from "vitest";
import {
  renderPendingBlock,
  parsePendingInbox,
  serializePendingInbox,
  removeEntry,
  resolveApplyDestination,
  formatAppliedBlock,
  formatTags,
  INBOX_HEADER,
  BASE_TAG,
  PendingEntry,
  PendingBlockFields,
} from "../src/memory/pending-inbox";
import { formatMemoryEntry, formatTimestamp } from "../src/memory/memory-writer";
import { resolveMemoryPaths, MemoryEntry } from "../src/memory/memory-types";

const paths = resolveMemoryPaths("Claude Code");
const FIXED_TS = new Date("2026-07-03T10:29:00").getTime();

function memEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    type: "decision",
    content: "We chose a local JSON index for v1.",
    project: "ExampleProject",
    source: "Claude Code",
    originTool: "add_memory",
    confidence: "medium",
    tags: ["decision"],
    relatedPaths: ["docs/architecture.md", "src/indexer.ts"],
    timestamp: FIXED_TS,
    ...overrides,
  };
}

function pending(overrides: Partial<PendingEntry> = {}): PendingEntry {
  return {
    index: 0,
    raw: "",
    timestampLabel: "2026-07-03 10:29",
    type: "note",
    source: "Claude Code",
    tags: [],
    content: "some content",
    relatedPaths: [],
    status: "pending",
    ...overrides,
  };
}

describe("formatTags", () => {
  it("leads with the base tag, dedupes, and strips leading #", () => {
    expect(formatTags(["#foo", "bar"])).toBe("#claude-code-engram #foo #bar");
  });

  it("does not duplicate the base tag if supplied", () => {
    expect(formatTags([BASE_TAG, "x"])).toBe("#claude-code-engram #x");
  });
});

describe("parsePendingInbox round-trip with formatMemoryEntry", () => {
  it("parses a rendered entry back into matching fields", () => {
    const entry = memEntry();
    const text = INBOX_HEADER + formatMemoryEntry(entry);
    const parsed = parsePendingInbox(text);
    expect(parsed.entries).toHaveLength(1);
    const e = parsed.entries[0];
    expect(e.index).toBe(0);
    expect(e.type).toBe("decision");
    expect(e.project).toBe("ExampleProject");
    expect(e.source).toBe("Claude Code");
    expect(e.originTool).toBe("add_memory");
    expect(e.confidence).toBe("medium");
    // Tags come back WITHOUT the base tag and WITHOUT a leading #.
    expect(e.tags).toEqual(["decision"]);
    expect(e.content).toBe("We chose a local JSON index for v1.");
    expect(e.relatedPaths).toEqual(["docs/architecture.md", "src/indexer.ts"]);
    expect(e.status).toBe("pending");
    expect(e.timestampLabel).toBe(formatTimestamp(FIXED_TS));
  });

  it("parses multiple entries in order with ascending indices", () => {
    const text =
      INBOX_HEADER +
      formatMemoryEntry(memEntry({ content: "First." })) +
      formatMemoryEntry(memEntry({ content: "Second." })) +
      formatMemoryEntry(memEntry({ content: "Third." }));
    const parsed = parsePendingInbox(text);
    expect(parsed.entries.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(parsed.entries.map((e) => e.content)).toEqual(["First.", "Second.", "Third."]);
  });

  it("parses an entry missing project / origin / confidence / related paths", () => {
    const entry = memEntry({
      project: undefined,
      originTool: undefined,
      confidence: undefined,
      relatedPaths: [],
    });
    const parsed = parsePendingInbox(INBOX_HEADER + formatMemoryEntry(entry));
    const e = parsed.entries[0];
    expect(e.project).toBeUndefined();
    expect(e.originTool).toBeUndefined();
    expect(e.confidence).toBeUndefined();
    expect(e.relatedPaths).toEqual([]);
  });

  it("captures content that itself contains structural-looking lines", () => {
    const trickyContent = ["Intro line", "Status: done", "---", "Type: x", "Final line"].join("\n");
    const entry = memEntry({ content: trickyContent, relatedPaths: [] });
    const parsed = parsePendingInbox(INBOX_HEADER + formatMemoryEntry(entry));
    expect(parsed.entries).toHaveLength(1);
    const e = parsed.entries[0];
    // The tricky body is fully captured and round-trips, and the real
    // structural fields are still read correctly.
    expect(e.content).toBe(trickyContent);
    expect(e.type).toBe("decision");
    expect(e.status).toBe("pending");
  });
});

describe("removeEntry", () => {
  it("removes a matching entry and keeps the others", () => {
    const text =
      INBOX_HEADER +
      formatMemoryEntry(memEntry({ content: "Keep one." })) +
      formatMemoryEntry(memEntry({ content: "Remove me." }));
    const parsed = parsePendingInbox(text);
    const removed = removeEntry(text, parsed.entries[1]);
    expect(removed).not.toBeNull();
    expect(removed).toContain("Keep one.");
    expect(removed).not.toContain("Remove me.");
    expect(parsePendingInbox(removed!).entries).toHaveLength(1);
  });

  it("returns null when no entry matches", () => {
    const text = INBOX_HEADER + formatMemoryEntry(memEntry());
    const bogus = pending({ raw: "## Pending Memory: nope\nnot in file\n---\n" });
    expect(removeEntry(text, bogus)).toBeNull();
  });
});

describe("serializePendingInbox", () => {
  it("returns just the header when there are no entries", () => {
    expect(serializePendingInbox(INBOX_HEADER, [])).toBe(INBOX_HEADER);
  });
});

describe("resolveApplyDestination", () => {
  it("routes project entries by type", () => {
    const cases: Array<[PendingBlockFields["type"], string]> = [
      ["architecture", "architecture.md"],
      ["decision", "decisions.md"],
      ["task", "tasks.md"],
      ["action-item", "tasks.md"],
      ["open-question", "open-questions.md"],
      ["note", "overview.md"],
    ];
    for (const [type, file] of cases) {
      const dest = resolveApplyDestination(pending({ project: "Proj", type }), paths);
      expect(dest.endsWith(file)).toBe(true);
      expect(dest.startsWith("Claude Code/")).toBe(true);
    }
  });

  it("routes global (project-less) entries by type", () => {
    const cases: Array<[string, string]> = [
      ["preference", "Global/preferences.md"],
      ["decision", "Global/conventions.md"],
      ["architecture", "Global/conventions.md"],
      ["note", "Global/profile.md"],
    ];
    for (const [type, suffix] of cases) {
      const dest = resolveApplyDestination(pending({ project: undefined, type }), paths);
      expect(dest.endsWith(suffix)).toBe(true);
      expect(dest.startsWith("Claude Code/")).toBe(true);
    }
  });
});

describe("formatAppliedBlock", () => {
  it("renders a graduated block without the pending status marker", () => {
    const entry = pending({
      type: "decision",
      content: "Use a local JSON index.",
      tags: ["indexing"],
      timestampLabel: "2026-07-03 10:29",
    });
    const block = formatAppliedBlock(entry);
    expect(block).toContain("Use a local JSON index.");
    expect(block).toContain("## Decision — 2026-07-03 10:29");
    expect(block).not.toContain("Status: pending");
    // Provenance footer carries the tags (base tag first).
    expect(block).toContain("#claude-code-engram");
    expect(block).toContain("#indexing");
  });

  it("title-cases hyphenated types", () => {
    const block = formatAppliedBlock(pending({ type: "action-item", timestampLabel: "L" }));
    expect(block).toContain("## Action Item — L");
  });
});

describe("renderPendingBlock", () => {
  it("is the single format producer for the inbox", () => {
    const block = renderPendingBlock({
      timestampLabel: "L",
      type: "note",
      source: "Claude Code",
      tags: [],
      content: "hello",
      relatedPaths: [],
      status: "pending",
    });
    expect(block).toContain("## Pending Memory: L");
    expect(block).toContain("Status: pending");
  });
});
