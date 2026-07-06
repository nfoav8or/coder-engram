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

  it("skips the index rewrite on a no-op refresh (nothing changed)", async () => {
    // Includes an empty note: zero-chunk notes must not defeat the no-op path.
    const { adapter, engine } = makeEngine({ "Notes/a.md": "# A\nalpha content", "Notes/empty.md": "" });
    await engine.reindex();
    const chunksMtime = await adapter.getMtime("Claude Code/Index/chunks.json");
    const metaMtime = await adapter.getMtime("Claude Code/Index/metadata.json");

    const result = await engine.refresh();
    expect(result.added + result.updated + result.removed).toBe(0);
    // No write may happen here: the Index/ files live inside the vault, so a
    // no-op refresh that persisted would re-fire the vault watcher and
    // schedule the next refresh indefinitely (besides re-serializing the
    // whole index on the main thread).
    expect(await adapter.getMtime("Claude Code/Index/chunks.json")).toBe(chunksMtime);
    expect(await adapter.getMtime("Claude Code/Index/metadata.json")).toBe(metaMtime);

    adapter.touch("Notes/a.md", "# A\nchanged content");
    await engine.refresh();
    expect(await adapter.getMtime("Claude Code/Index/chunks.json")).not.toBe(chunksMtime);
  });

  it("a refresh reads only changed notes from disk", async () => {
    const { adapter, engine } = makeEngine({
      "Notes/a.md": "# A\nalpha content",
      "Notes/b.md": "# B\nbeta content",
    });
    await engine.reindex();
    let reads = 0;
    const orig = adapter.read.bind(adapter);
    adapter.read = async (p: string) => {
      reads++;
      return orig(p);
    };

    await engine.refresh(); // nothing changed → no file reads at all
    expect(reads).toBe(0);

    adapter.touch("Notes/b.md", "# B\nquasar telemetry");
    await engine.refresh();
    expect(reads).toBe(1); // only the changed note
    expect((await engine.search({ query: "quasar telemetry" })).length).toBeGreaterThan(0);
  });

  it("applies a new tag exclusion to unchanged notes on the next refresh", async () => {
    // The skip-unchanged fast path must be invalidated by a scan-config change:
    // known mtimes encode eligibility verdicts under the OLD config, and a note
    // a new exclusion should hide has not changed on disk.
    const { engine } = makeEngine({
      "Notes/a.md": "# A\nalpha content",
      "Notes/p.md": "#private\n\nsensitive payload here",
    });
    await engine.reindex();
    expect((await engine.search({ query: "sensitive payload" })).length).toBeGreaterThan(0);

    engine.updateSettings({ ...DEFAULT_SETTINGS, excludedTags: ["private"] });
    await engine.refresh();
    expect((await engine.search({ query: "sensitive payload" })).length).toBe(0);
  });

  it("re-checks exclusions after loading a persisted index from a moved-back root", async () => {
    const { engine } = makeEngine({
      "Notes/a.md": "# A\nalpha content",
      "Notes/p.md": "#private\n\nsensitive payload here",
    });
    // Index persisted at the default root WITHOUT exclusions: it legitimately
    // contains the #private note.
    await engine.reindex();

    // Move roots and adopt the exclusion; the empty new root reindexes under
    // the exclusion config and snapshots its scan key.
    engine.updateSettings({ ...DEFAULT_SETTINGS, memoryRoot: "Elsewhere", excludedTags: ["private"] });
    await engine.refresh();
    expect((await engine.search({ query: "sensitive payload" })).length).toBe(0);

    // Move back: loadIndex adopts the OLD index (built before the exclusion).
    // The scan config hasn't changed since the key was snapshotted, so without
    // a key reset the fast path would stub the unchanged #private note and
    // keep serving it despite the exclusion.
    engine.updateSettings({ ...DEFAULT_SETTINGS, memoryRoot: "Claude Code", excludedTags: ["private"] });
    expect(await engine.loadIndex()).toBe(true);
    await engine.refresh();
    expect((await engine.search({ query: "sensitive payload" })).length).toBe(0);
  });

  it("adds memory to the pending inbox by default", async () => {
    const { adapter, engine } = makeEngine({});
    const { path } = await engine.addMemory({
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
    expect(changed.rootChanged).toBe(false);
    expect(changed.embeddingChanged).toBe(false);
    expect(changed.scanConfigChanged).toBe(false);

    // A scan-eligibility change is reported so the host can refresh — even
    // when the ONE shared settings object is mutated in place (the production
    // settings-tab pattern).
    const shared = { ...DEFAULT_SETTINGS };
    engine.updateSettings(shared);
    shared.excludedTags = ["private"];
    expect(engine.updateSettings(shared).scanConfigChanged).toBe(true);
    expect(engine.updateSettings(shared).scanConfigChanged).toBe(false); // settled
    expect(engine.getIndexStats().chunkCount).toBe(before); // index NOT wiped
    expect((await engine.search({ query: "alpha" })).length).toBeGreaterThan(0);
  });

  it("resets the index when the memory root moves", async () => {
    const { engine } = makeEngine({ "Notes/a.md": "# A\nalpha" });
    await engine.reindex();
    const changed = engine.updateSettings({ ...DEFAULT_SETTINGS, memoryRoot: "Brain" });
    expect(changed.rootChanged).toBe(true);
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
