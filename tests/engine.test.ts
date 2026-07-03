import { describe, it, expect } from "vitest";
import { EngramEngine } from "../src/engine";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import { NULL_LOGGER } from "../src/utils/logger";

function makeEngine(seed: Record<string, string>) {
  const adapter = new InMemoryVaultAdapter("v", seed);
  let t = 10_000;
  const engine = new EngramEngine(adapter, { ...DEFAULT_SETTINGS }, NULL_LOGGER, () => t++);
  return { adapter, engine };
}

describe("EngramEngine end-to-end (M1 acceptance)", () => {
  it("reindexes then returns note paths and snippets for a query", async () => {
    const { engine } = makeEngine({
      "Notes/rag.md": "# RAG Pipeline\nThe vault indexing pipeline chunks markdown notes for retrieval.",
      "Notes/embeddings.md": "# Embeddings\nOllama and OpenAI compatible embedding backends.",
    });
    const stats = await engine.reindex();
    expect(stats.noteCount).toBe(2);

    const results = await engine.search({ query: "indexing markdown retrieval" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.notePath).toBe("Notes/rag.md");
    expect(results[0].snippet.length).toBeGreaterThan(0);
  });

  it("persists an index that a fresh engine can load", async () => {
    const { adapter, engine } = makeEngine({ "Notes/a.md": "# A\nalpha content" });
    await engine.reindex();

    let t = 50_000;
    const engine2 = new EngramEngine(adapter, { ...DEFAULT_SETTINGS }, NULL_LOGGER, () => t++);
    expect(await engine2.loadIndex()).toBe(true);
    expect(engine2.getIndexStats().noteCount).toBe(1);
  });

  it("adds memory to the pending inbox by default", async () => {
    const { adapter, engine } = makeEngine({});
    const path = await engine.addMemory({
      type: "decision",
      content: "Use a local JSON index for v1.",
      project: "Demo",
      tags: ["decision"],
    });
    expect(path).toBe("Claude Code/Memory/Inbox/pending-memory.md");
    const inbox = await adapter.read(path);
    expect(inbox).toContain("Use a local JSON index for v1.");
    expect(inbox).toContain("Type: decision");
  });

  it("refuses direct writes by default (inbox is the safe path)", async () => {
    const { adapter, engine } = makeEngine({});
    // Even when asking for a direct write, default settings disallow it → falls back to throwing.
    await expect(
      engine.addMemory(
        { type: "note", content: "x" },
        { direct: true, subpath: "Memory/Global/profile.md" },
      ),
    ).rejects.toThrow();
    // Nothing was written to the global file.
    expect(await adapter.exists("Claude Code/Memory/Global/profile.md")).toBe(false);
  });

  it("creates project memory structure and reads it back", async () => {
    const { engine } = makeEngine({});
    await engine.ensureScaffold();
    const folder = await engine.createProject("Demo");
    expect(folder).toBe("Claude Code/Memory/Projects/Demo");
    expect(await engine.listProjects()).toContain("Demo");
    expect(await engine.getProjectContext("Demo")).toContain("Overview");
  });

  it("rejects a memory root that escapes the vault at settings-update time", () => {
    const { engine } = makeEngine({});
    expect(() =>
      engine.updateSettings({ ...DEFAULT_SETTINGS, memoryRoot: "../escape" }),
    ).toThrow();
  });

  it("preserves the loaded index across an unrelated settings change", async () => {
    const { engine } = makeEngine({ "Notes/a.md": "# A\nalpha content" });
    await engine.reindex();
    const before = engine.getIndexStats().chunkCount;
    expect(before).toBeGreaterThan(0);

    // Change something other than the memory root.
    const changed = engine.updateSettings({ ...DEFAULT_SETTINGS, defaultProject: "Demo" });
    expect(changed).toBe(false);
    expect(engine.getIndexStats().chunkCount).toBe(before); // index NOT wiped
    expect((await engine.search({ query: "alpha" })).length).toBeGreaterThan(0);
  });

  it("resets the index when the memory root moves", async () => {
    const { engine } = makeEngine({ "Notes/a.md": "# A\nalpha" });
    await engine.reindex();
    const changed = engine.updateSettings({ ...DEFAULT_SETTINGS, memoryRoot: "Brain" });
    expect(changed).toBe(true);
    expect(engine.getIndexStats().chunkCount).toBe(0);
  });

  it("refuses to end-session on a note outside the memory root", async () => {
    const { engine } = makeEngine({});
    await expect(engine.endSession("Blog/sessions/post.md", "done")).rejects.toThrow();
  });

  it("ends a session note under the projects root", async () => {
    const { adapter, engine } = makeEngine({});
    const file = await engine.startSession("Demo", "2026-07-03-1000");
    await engine.endSession(file, "Wrapped up.");
    expect(await adapter.read(file)).toContain("Wrapped up.");
  });

  it("writes a settings backup inside the Config folder", async () => {
    const { adapter, engine } = makeEngine({});
    await engine.backupSettings({ ...DEFAULT_SETTINGS, defaultProject: "Demo" });
    const backup = await adapter.read("Claude Code/Config/plugin-settings-backup.json");
    expect(JSON.parse(backup).defaultProject).toBe("Demo");
  });
});
