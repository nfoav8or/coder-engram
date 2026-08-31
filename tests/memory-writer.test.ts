import { describe, it, expect } from "vitest";
import { MemoryWriter, formatMemoryEntry } from "../src/memory/memory-writer";
import { resolveMemoryPaths, MemoryEntry } from "../src/memory/memory-types";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { ConfigError, PathSecurityError } from "../src/utils/errors";
import { INBOX_HEADER } from "../src/memory/pending-inbox";

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
    expect(block).toContain("#coder-engram");
    expect(block).toContain("Status: pending");
    expect(block).toContain("* docs/architecture.md");
  });
});

describe("MemoryWriter.proposeToInbox", () => {
  it("writes to the pending inbox by default and appends on subsequent calls", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: false });

    const { path: target } = await writer.proposeToInbox(entry());
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

  it("de-duplicates an identical proposal (same content/type/project)", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: false });

    const first = await writer.proposeToInbox(entry());
    expect(first.duplicate).toBe(false);
    // Same content/type/project but different timestamp/source/tags → still a dup.
    const second = await writer.proposeToInbox(
      entry({ timestamp: 1_800_000_000_000, source: "MCP", tags: ["other"] }),
    );
    expect(second.duplicate).toBe(true);

    const inbox = await adapter.read(first.path);
    expect(inbox.match(/## Pending Memory:/g)?.length).toBe(1);
  });

  it("de-duplicates across a case-variant project name", async () => {
    // The dedup key folded content for case but the project for Unicode form
    // ONLY, so "engram" after "Engram" was a different key and the same fact
    // landed twice. Case-variant project names are the norm rather than the
    // exception — an agent derives one from a working-directory path, a user
    // types another — and every other project comparison in the codebase
    // (retrieval filters, scanner exclusions, `list_pending_memory`) already
    // folds case. A dedup that misses this defeats its own purpose.
    const adapter = new InMemoryVaultAdapter("v", {});
    const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: false });

    const first = await writer.proposeToInbox(entry({ project: "Engram" }));
    expect(first.duplicate).toBe(false);
    const variant = await writer.proposeToInbox(entry({ project: "engram" }));
    expect(variant.duplicate).toBe(true);

    const inbox = await adapter.read(first.path);
    expect(inbox.match(/## Pending Memory:/g)?.length).toBe(1);
  });

  describe("the dedup scan is cached against the inbox's mtime", () => {
    // Reading and re-parsing the whole inbox per call is O(inbox), and the
    // backlog grows with agent usage rather than vault size. These pin the
    // cache's two halves: that it actually avoids the re-read, and that it
    // cannot serve a stale answer after someone else changes the file.
    it("detects a duplicate without re-reading the inbox", async () => {
      const adapter = new InMemoryVaultAdapter("v", {});
      const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: false });
      await writer.proposeToInbox(entry());

      const reads: string[] = [];
      const realRead = adapter.read.bind(adapter);
      adapter.read = async (p: string) => {
        reads.push(p);
        return realRead(p);
      };

      const second = await writer.proposeToInbox(entry({ timestamp: 1_800_000_000_000 }));
      expect(second.duplicate).toBe(true);
      expect(reads).toEqual([]);
    });

    it("does not report a duplicate after a discard that reused the same mtime", async () => {
      // The dedup cache is keyed on mtime, but mtime is NOT a reliable change
      // signal: resolution is coarse on some filesystems, and a discard
      // followed immediately by a propose can land in the same tick. If the
      // cache survived that, a genuinely new proposal would be reported as a
      // duplicate and silently dropped — data loss, not a slow path.
      //
      // InMemoryVaultAdapter's mtime is a strictly increasing counter, so it
      // can never produce the collision this guards against; the adapter is
      // subclassed here to freeze mtime and make the hazard reproducible.
      class CoarseMtimeAdapter extends InMemoryVaultAdapter {
        async getMtime(): Promise<number | null> {
          return 1;
        }
      }
      const adapter = new CoarseMtimeAdapter("v", {});
      const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: false });

      const first = await writer.proposeToInbox(entry());
      expect(first.duplicate).toBe(false);

      const [pending] = (await writer.readInbox()).entries;
      await writer.discardPending(pending);

      const again = await writer.proposeToInbox(entry({ timestamp: 1_800_000_000_000 }));
      expect(again.duplicate, "a discarded memory must be proposable again").toBe(false);
      expect((await adapter.read(first.path)).match(/## Pending Memory:/g)?.length).toBe(1);
    });

    it("re-reads and stays correct after the inbox is edited outside the writer", async () => {
      const adapter = new InMemoryVaultAdapter("v", {});
      const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: false });
      const { path } = await writer.proposeToInbox(entry());

      // Stand in for the user discarding the entry in Obsidian: the cache
      // still holds its key, but the file no longer contains it.
      await adapter.write(path, INBOX_HEADER);

      const again = await writer.proposeToInbox(entry({ timestamp: 1_800_000_000_000 }));
      expect(again.duplicate, "a discarded entry must be proposable again").toBe(false);
      expect((await adapter.read(path)).match(/## Pending Memory:/g)?.length).toBe(1);
    });
  });

  it("de-duplicates a restatement differing only in whitespace or case", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: false });

    const base = await writer.proposeToInbox(entry({ content: "We chose a local JSON index." }));
    expect(base.duplicate).toBe(false);
    // An agent re-proposing across sessions rarely reproduces its own wording
    // byte-for-byte: a re-wrap, an indent, or different capitalization.
    const rewrapped = await writer.proposeToInbox(entry({ content: "We chose a local\n  JSON  index." }));
    const recased = await writer.proposeToInbox(entry({ content: "we chose a LOCAL json index." }));
    expect(rewrapped.duplicate).toBe(true);
    expect(recased.duplicate).toBe(true);

    const inbox = await adapter.read(base.path);
    expect(inbox.match(/## Pending Memory:/g)?.length).toBe(1);
  });

  it("de-duplicates a restatement differing only in Unicode form", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: false });

    // Built with normalize() rather than written as literals: the two forms
    // render identically, so a literal pair can silently become one string in
    // an editor and leave this asserting nothing.
    const words = "The café deploy runs at midnight";
    const project = "Café Project";
    expect(words.normalize("NFC")).not.toBe(words.normalize("NFD"));

    const composed = await writer.proposeToInbox(
      entry({ content: words.normalize("NFC"), project: project.normalize("NFC") }),
    );
    expect(composed.duplicate).toBe(false);

    // The same fact arriving from a macOS path or filename is decomposed. It is
    // the same characters, so it must collide rather than open a second card
    // the reviewer cannot tell apart from the first.
    const decomposed = await writer.proposeToInbox(
      entry({ content: words.normalize("NFD"), project: project.normalize("NFD") }),
    );
    expect(decomposed.duplicate).toBe(true);

    const inbox = await adapter.read(composed.path);
    expect(inbox.match(/## Pending Memory:/g)?.length).toBe(1);
  });

  it("keeps a proposal that adds detail to a pending one", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: false });

    // Normalization must stay an EXACT word comparison: a restatement carrying
    // genuinely new detail is a different memory and must survive review.
    await writer.proposeToInbox(entry({ content: "We chose a local JSON index." }));
    const elaborated = await writer.proposeToInbox(
      entry({ content: "We chose a local JSON index because it rebuilds in under a second." }),
    );
    expect(elaborated.duplicate).toBe(false);

    const inbox = await adapter.read(elaborated.path);
    expect(inbox.match(/## Pending Memory:/g)?.length).toBe(2);
  });

  it("does not de-duplicate when content, type, or project differ", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: false });

    await writer.proposeToInbox(entry());
    const diffContent = await writer.proposeToInbox(entry({ content: "A different decision." }));
    const diffProject = await writer.proposeToInbox(entry({ project: "OtherProject" }));
    const diffType = await writer.proposeToInbox(entry({ type: "note" }));
    expect(diffContent.duplicate).toBe(false);
    expect(diffProject.duplicate).toBe(false);
    expect(diffType.duplicate).toBe(false);

    const inbox = await adapter.read(diffContent.path);
    expect(inbox.match(/## Pending Memory:/g)?.length).toBe(4);
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
    // The file must already EXIST for this to mean anything: writing to a new
    // path looks identical whether the writer appended or overwrote, so an
    // append-only mode that silently overwrote passed this test for years.
    const adapter = new InMemoryVaultAdapter("v", {
      "Claude Code/Memory/Global/profile.md": "# Profile\n\nExisting notes the user wrote.\n",
    });
    const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: true });
    const target = await writer.directWrite("Memory/Global/profile.md", entry());
    expect(target).toBe("Claude Code/Memory/Global/profile.md");
    const after = await adapter.read(target);
    expect(after).toContain("Existing notes the user wrote.");
    expect(after).toContain("## Pending Memory:");
  });

  it("never destroys existing content, even with append-only off", async () => {
    // appendOnly governs HOW the write happens, not whether the user's file
    // survives it: with it off the writer read-modify-writes, and that read is
    // the only thing standing between a direct write and a wiped memory file.
    const adapter = new InMemoryVaultAdapter("v", {
      "Claude Code/Memory/Global/profile.md": "# Profile\n\nExisting notes the user wrote.\n",
    });
    const writer = new MemoryWriter(adapter, paths, { appendOnly: false, allowDirectWrites: true });
    const target = await writer.directWrite("Memory/Global/profile.md", entry());
    const after = await adapter.read(target);
    expect(after).toContain("Existing notes the user wrote.");
    expect(after).toContain("## Pending Memory:");
  });

  it("rejects a direct-write target that escapes the memory root", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const writer = new MemoryWriter(adapter, paths, { appendOnly: true, allowDirectWrites: true });
    await expect(writer.directWrite("../../outside.md", entry())).rejects.toBeInstanceOf(
      PathSecurityError,
    );
  });
});
