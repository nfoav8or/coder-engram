import { describe, it, expect } from "vitest";
import { MemoryWriter } from "../src/memory/memory-writer";
import { resolveMemoryPaths, MemoryEntry } from "../src/memory/memory-types";
import { resolveApplyDestination, INBOX_HEADER } from "../src/memory/pending-inbox";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { ConfigError } from "../src/utils/errors";

const paths = resolveMemoryPaths("Claude Code");
const FIXED_TS = new Date("2026-07-03T10:29:00").getTime();

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    type: "decision",
    content: "We chose a local JSON index for v1.",
    project: "Demo",
    source: "Claude Code",
    originTool: "add_memory",
    confidence: "medium",
    tags: ["decision"],
    relatedPaths: [],
    timestamp: FIXED_TS,
    ...overrides,
  };
}

function makeWriter(opts: { appendOnly: boolean; allowDirectWrites: boolean }) {
  const adapter = new InMemoryVaultAdapter("v", {});
  const writer = new MemoryWriter(adapter, paths, opts);
  return { adapter, writer };
}

describe("MemoryWriter.readInbox", () => {
  it("returns an empty parse with the standard header on a fresh vault", async () => {
    const { writer } = makeWriter({ appendOnly: true, allowDirectWrites: false });
    const parsed = await writer.readInbox();
    expect(parsed.header).toBe(INBOX_HEADER);
    expect(parsed.entries).toEqual([]);
  });

  it("returns two entries after two proposeToInbox calls", async () => {
    const { writer } = makeWriter({ appendOnly: true, allowDirectWrites: false });
    await writer.proposeToInbox(entry({ content: "First." }));
    await writer.proposeToInbox(entry({ content: "Second." }));
    const parsed = await writer.readInbox();
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries.map((e) => e.content)).toEqual(["First.", "Second."]);
  });
});

describe("MemoryWriter.applyPending", () => {
  it("appends the applied block to the destination and drops it from the inbox", async () => {
    const { adapter, writer } = makeWriter({ appendOnly: true, allowDirectWrites: false });
    await writer.proposeToInbox(entry());
    const parsed = await writer.readInbox();
    const target = parsed.entries[0];

    const { destination } = await writer.applyPending(target);
    expect(destination).toBe(resolveApplyDestination(target, paths));
    const written = await adapter.read(destination);
    expect(written).toContain("We chose a local JSON index for v1.");

    // Inbox now has one fewer entry.
    expect((await writer.readInbox()).entries).toHaveLength(0);
  });

  it("is NOT gated by allowDirectWrites/appendOnly (human-approved promotion)", async () => {
    const { adapter, writer } = makeWriter({ appendOnly: false, allowDirectWrites: false });
    await writer.proposeToInbox(entry());
    const target = (await writer.readInbox()).entries[0];
    const { destination } = await writer.applyPending(target);
    expect(await adapter.exists(destination)).toBe(true);
  });

  it("never overwrites: it appends to an existing destination file", async () => {
    const { adapter, writer } = makeWriter({ appendOnly: false, allowDirectWrites: true });
    await writer.proposeToInbox(entry());
    const target = (await writer.readInbox()).entries[0];
    const destination = resolveApplyDestination(target, paths);
    await adapter.write(destination, "EXISTING\n");

    await writer.applyPending(target);
    const written = await adapter.read(destination);
    expect(written).toContain("EXISTING");
    expect(written).toContain("We chose a local JSON index for v1.");
  });

  it("keeps the entry in the inbox when the destination write fails", async () => {
    // The two writes are ordered destination-first on purpose: whichever one
    // fails, the entry must still exist somewhere. Clearing the inbox first
    // would mean a failed destination write loses the memory outright, and
    // nothing else in the suite notices that swap — the failure only appears
    // when a write actually fails.
    const { adapter, writer } = makeWriter({ appendOnly: true, allowDirectWrites: false });
    await writer.proposeToInbox(entry());
    const target = (await writer.readInbox()).entries[0];
    const destination = resolveApplyDestination(target, paths);

    const realWrite = adapter.write.bind(adapter);
    adapter.write = (path: string, content: string) =>
      path === destination ? Promise.reject(new Error("disk full")) : realWrite(path, content);

    await expect(writer.applyPending(target)).rejects.toThrow(/disk full/);
    adapter.write = realWrite;
    expect((await writer.readInbox()).entries).toHaveLength(1);
    expect(await adapter.exists(destination)).toBe(false);
  });

  it("throws when the entry is no longer in the inbox", async () => {
    const { writer } = makeWriter({ appendOnly: true, allowDirectWrites: false });
    await writer.proposeToInbox(entry());
    const target = (await writer.readInbox()).entries[0];
    await writer.applyPending(target);
    // Second apply of the same (now-removed) entry must throw.
    await expect(writer.applyPending(target)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("MemoryWriter.discardPending", () => {
  it("removes the entry from the inbox and writes nothing to any destination", async () => {
    const { adapter, writer } = makeWriter({ appendOnly: true, allowDirectWrites: false });
    await writer.proposeToInbox(entry({ content: "First." }));
    await writer.proposeToInbox(entry({ content: "Second." }));
    const parsed = await writer.readInbox();
    const target = parsed.entries[0];
    const destination = resolveApplyDestination(target, paths);

    await writer.discardPending(target);
    expect((await writer.readInbox()).entries).toHaveLength(1);
    expect(await adapter.exists(destination)).toBe(false);
  });
});
