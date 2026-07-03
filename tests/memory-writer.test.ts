import { describe, it, expect } from "vitest";
import { MemoryWriter, formatMemoryEntry } from "../src/memory/memory-writer";
import { resolveMemoryPaths, MemoryEntry } from "../src/memory/memory-types";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { ConfigError, PathSecurityError } from "../src/utils/errors";

const paths = resolveMemoryPaths("Claude Code");

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    type: "decision",
    content: "We chose a local JSON index for v1.",
    project: "ExampleProject",
    source: "Claude Code",
    originTool: "add_memory",
    confidence: "medium",
    tags: ["decision"],
    relatedPaths: ["docs/architecture.md", "src/indexer.ts"],
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe("formatMemoryEntry", () => {
  it("renders the required fields", () => {
    const block = formatMemoryEntry(entry());
    expect(block).toContain("## Pending Memory:");
    expect(block).toContain("Type: decision");
    expect(block).toContain("Project: ExampleProject");
    expect(block).toContain("Source: Claude Code");
    expect(block).toContain("Confidence: medium");
    expect(block).toContain("#claude-code-engram");
    expect(block).toContain("Status: pending");
    expect(block).toContain("* docs/architecture.md");
  });
});

describe("MemoryWriter.proposeToInbox", () => {
  it("writes to the pending inbox by default and appends on subsequent calls", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: false });

    const target = await writer.proposeToInbox(entry());
    expect(target).toBe("Claude Code/Memory/Inbox/pending-memory.md");
    const first = await adapter.read(target);
    expect(first).toContain("# Pending Memory Inbox");
    expect(first).toContain("We chose a local JSON index");

    await writer.proposeToInbox(entry({ content: "Second decision." }));
    const second = await adapter.read(target);
    expect(second).toContain("Second decision.");
    // Two entry blocks present.
    expect(second.match(/## Pending Memory:/g)?.length).toBe(2);
  });
});

describe("MemoryWriter.directWrite gating", () => {
  it("throws when direct writes are disabled", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: false });
    await expect(writer.directWrite("Memory/Global/profile.md", entry())).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("appends when direct writes are enabled and append-only is on", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: true });
    const target = await writer.directWrite("Memory/Global/profile.md", entry());
    expect(target).toBe("Claude Code/Memory/Global/profile.md");
    expect(await adapter.read(target)).toContain("## Pending Memory:");
  });

  it("rejects a direct-write target that escapes the memory root", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: true });
    await expect(writer.directWrite("../../outside.md", entry())).rejects.toBeInstanceOf(
      PathSecurityError,
    );
  });
});
