/**
 * Regression tests for the M4 /loop review findings:
 *  - H1 (HIGH): inbox read-modify-write must be serialized so concurrent
 *    apply/discard cannot resurrect an entry (lost removal) or duplicate a
 *    graduated block (double append). A retry of an already-applied entry must
 *    reject WITHOUT re-appending to the destination.
 *  - M2 (MED): note content that merely contains a literal "Related files:"
 *    line (with no real related section) must not be truncated or have the
 *    following lines harvested as related paths.
 */

import { describe, it, expect } from "vitest";
import { MemoryWriter } from "../src/memory/memory-writer";
import { resolveMemoryPaths, MemoryEntry } from "../src/memory/memory-types";
import {
  INBOX_HEADER,
  parsePendingInbox,
  renderPendingBlock,
  resolveApplyDestination,
} from "../src/memory/pending-inbox";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";

const paths = resolveMemoryPaths("Claude Code");
const FIXED_TS = new Date("2026-07-03T10:29:00").getTime();

function entry(content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    type: "note",
    content,
    source: "Claude Code",
    tags: [],
    relatedPaths: [],
    timestamp: FIXED_TS,
    ...overrides,
  };
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

describe("H1: inbox mutations are serialized", () => {
  it("concurrent apply of two distinct entries: both graduate once, inbox empties (no resurrection)", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: false });
    await writer.proposeToInbox(entry("Alpha entry content"));
    await writer.proposeToInbox(entry("Beta entry content"));

    const [a, b] = (await writer.readInbox()).entries;
    // Fire both applies WITHOUT awaiting between them.
    const results = await Promise.allSettled([writer.applyPending(a), writer.applyPending(b)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    // Both entries share the same destination (note + no project -> global profile).
    const destination = resolveApplyDestination(a, paths);
    const written = await adapter.read(destination);
    expect(countOccurrences(written, "Alpha entry content")).toBe(1);
    expect(countOccurrences(written, "Beta entry content")).toBe(1);

    // Neither entry was resurrected by a clobbering rewrite.
    expect((await writer.readInbox()).entries).toHaveLength(0);
  });

  it("concurrent double-apply of the SAME entry: one succeeds, one rejects, no duplicate block", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: false });
    await writer.proposeToInbox(entry("Only entry content"));
    const [only] = (await writer.readInbox()).entries;

    const results = await Promise.allSettled([writer.applyPending(only), writer.applyPending(only)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const destination = resolveApplyDestination(only, paths);
    const written = await adapter.read(destination);
    // Guard-before-append means the rejected retry never appended a second copy.
    expect(countOccurrences(written, "Only entry content")).toBe(1);
    expect((await writer.readInbox()).entries).toHaveLength(0);
  });
});

describe("M2: content containing a literal 'Related files:' line", () => {
  it("does not truncate content or harvest following lines as related paths", () => {
    const content = "See the notes below.\nRelated files:\n* src/foo.ts\n* src/bar.ts";
    const block = renderPendingBlock({
      timestampLabel: "2026-07-03 10:29",
      type: "note",
      source: "Claude Code",
      tags: [],
      content,
      relatedPaths: [], // no real related section is emitted
      status: "pending",
    });
    const { entries } = parsePendingInbox(INBOX_HEADER + block);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe(content);
    expect(entries[0].relatedPaths).toEqual([]);
  });

  it("still parses a genuine related-files section", () => {
    const block = renderPendingBlock({
      timestampLabel: "2026-07-03 10:29",
      type: "note",
      source: "Claude Code",
      tags: [],
      content: "A short note.",
      relatedPaths: ["src/foo.ts", "src/bar.ts"],
      status: "pending",
    });
    const { entries } = parsePendingInbox(INBOX_HEADER + block);
    expect(entries[0].content).toBe("A short note.");
    expect(entries[0].relatedPaths).toEqual(["src/foo.ts", "src/bar.ts"]);
  });
});
