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

  it("finds a frontmatter-only alias-hub note by its alias", async () => {
    const { engine } = makeEngine({
      "Hubs/Quartzine Protocol.md": "---\naliases: [QZP]\ntags: [protocol]\n---\n",
      "Notes/filler.md": "# Filler\ngeneric body words here",
    });
    await engine.reindex();
    const results = await engine.search({ query: "QZP" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.notePath).toBe("Hubs/Quartzine Protocol.md");
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
    const parts = await engine.getProjectContext("Demo");
    expect(parts.map((p) => p.content).join("\n")).toContain("Overview");
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

  it("still persists a reindex when a memory-root change lands mid-pass", async () => {
    // `indexChain` serializes index passes against EACH OTHER, but
    // `updateSettings` is synchronous and runs off-chain — a settings blur or
    // its debounce. On a root change it swaps in a fresh, empty IndexManager.
    // Because build/refresh yield to the event loop mid-pass, re-reading
    // `this.index` after an await could land on that new instance, and
    // `persist()` on an empty manager returns silently: the whole completed
    // build was discarded while the log still reported success.
    const seed: Record<string, string> = {};
    for (let i = 0; i < 40; i++) seed[`Notes/n${i}.md`] = `# Note ${i}\nbody ${i}`;
    const { adapter, engine } = makeEngine(seed);

    const reindexing = engine.reindex();
    // Land the root change while the pass is in flight.
    await Promise.resolve();
    engine.updateSettings({ ...DEFAULT_SETTINGS, memoryRoot: "Brain" });
    await reindexing;

    // The pass belonged to the original root, so its output must be there —
    // not silently dropped.
    const persisted = JSON.parse(await adapter.read("Claude Code/Index/chunks.json")) as unknown[];
    expect(persisted.length, "the completed build must reach disk").toBeGreaterThan(0);
  });

  it("refuses a session stamp that would escape the project's sessions folder", async () => {
    // The stamp is caller-supplied; nothing upstream sanitizes it. It must be
    // resolved against the sessions root rather than concatenated, so a
    // traversal payload can't land the note elsewhere in the vault.
    const { engine } = makeEngine({});
    await expect(engine.startSession("Demo", "../../../evil")).rejects.toThrow();
  });

  it("writes a settings backup inside the Config folder", async () => {
    const { adapter, engine } = makeEngine({});
    await engine.backupSettings({ ...DEFAULT_SETTINGS, defaultProject: "Demo" });
    const backup = await adapter.read("Claude Code/Config/plugin-settings-backup.json");
    expect((JSON.parse(backup) as { defaultProject: string }).defaultProject).toBe("Demo");
  });
});

describe("startup scan after a reload", () => {
  const seed = () => {
    const notes: Record<string, string> = {};
    for (let i = 0; i < 12; i++) notes[`Notes/n${i}.md`] = `# Note ${i}\n\nBody ${i}.`;
    notes["Private/secret.md"] = "# Secret\n\nhidden";
    return notes;
  };

  /** Count reads of note files during `run`, ignoring index/cache reads. */
  async function countNoteReads(adapter: InMemoryVaultAdapter, run: () => Promise<unknown>) {
    let reads = 0;
    const real = adapter.read.bind(adapter);
    adapter.read = async (p: string) => {
      if (!p.startsWith("Claude Code/")) reads++;
      return real(p);
    };
    await run();
    adapter.read = real;
    return reads;
  }

  it("re-reads nothing when the scan config is unchanged", async () => {
    // The index records the config its mtimes were gathered under, so a reload
    // can tell the verdicts still apply. Without that record every startup
    // re-read every note in the vault — real disk I/O in Obsidian, not a cached
    // read, and it grows with the vault.
    const adapter = new InMemoryVaultAdapter("v", seed());
    let t = 10_000;
    const settings = { ...DEFAULT_SETTINGS };
    const first = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++);
    await first.reindex();

    const reloaded = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++);
    expect(await reloaded.loadIndex()).toBe(true);
    expect(await countNoteReads(adapter, () => reloaded.refresh())).toBe(0);
  });

  it("upgrades an index that predates the scan key, on a vault where nothing changed", async () => {
    // The shape every user of the previous version has on disk. The first
    // launch cannot use the fast path (the config the mtimes were gathered
    // under is unknown) — but it must WRITE what it learned, or nothing ever
    // does: an unchanged vault reports no additions, the engine skips the
    // persist, and every launch after it re-reads the whole vault forever.
    const adapter = new InMemoryVaultAdapter("v", seed());
    let t = 10_000;
    const settings = { ...DEFAULT_SETTINGS };
    const first = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++);
    await first.reindex();

    const metaPath = "Claude Code/Index/metadata.json";
    const meta = JSON.parse(await adapter.read(metaPath)) as Record<string, unknown>;
    delete meta.scanConfigKey;
    await adapter.write(metaPath, JSON.stringify(meta));

    const upgrade = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++);
    await upgrade.loadIndex();
    expect(await countNoteReads(adapter, () => upgrade.refresh())).toBeGreaterThan(0);

    const next = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++);
    await next.loadIndex();
    expect(await countNoteReads(adapter, () => next.refresh())).toBe(0);
  });

  it("recovers when the stored metadata has the wrong types", async () => {
    // metadata.json sits in the vault, so a sync conflict can corrupt it. Both
    // fields must be type-checked rather than trusted, and the launch that
    // rejects them has to write good ones back.
    const adapter = new InMemoryVaultAdapter("v", seed());
    let t = 10_000;
    const settings = { ...DEFAULT_SETTINGS };
    const first = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++);
    await first.reindex();

    const metaPath = "Claude Code/Index/metadata.json";
    const meta = JSON.parse(await adapter.read(metaPath)) as Record<string, unknown>;
    await adapter.write(
      metaPath,
      JSON.stringify({ ...meta, scanConfigKey: { not: "a string" }, noteMtimes: "nonsense" }),
    );

    const recovering = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++);
    expect(await recovering.loadIndex()).toBe(true);
    await recovering.refresh();

    const next = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++);
    await next.loadIndex();
    expect(await countNoteReads(adapter, () => next.refresh())).toBe(0);
    expect((await next.search({ query: "Body 3", limit: 3 })).length).toBeGreaterThan(0);
  });

  it("re-reads everything when an exclusion was added while it was closed", async () => {
    // The safety half, and the reason the fast path was skipped outright before:
    // an "unchanged" stub must not stand in for a note a NEW exclusion should
    // now hide. A different config means the stored verdicts are foreign.
    const adapter = new InMemoryVaultAdapter("v", seed());
    let t = 10_000;
    const first = new EngramEngine(adapter, { ...DEFAULT_SETTINGS }, NULL_LOGGER, () => t++);
    await first.reindex();

    const stricter = { ...DEFAULT_SETTINGS, excludedFolders: ["Private"] };
    const reloaded = new EngramEngine(adapter, stricter, NULL_LOGGER, () => t++);
    expect(await reloaded.loadIndex()).toBe(true);
    expect(await countNoteReads(adapter, () => reloaded.refresh())).toBeGreaterThan(0);
    expect(reloaded.getNoteChunks("Private/secret.md")).toEqual([]);
  });
});

describe("settings backup", () => {
  it("never writes the server token or embedding API key into the vault", async () => {
    // The backup lives inside the vault, and a vault gets synced, backed up,
    // and committed to git — so a secret written here in the clear travels
    // everywhere the vault goes. Nothing reads this file back, so redaction
    // costs the recovery point nothing.
    const adapter = new InMemoryVaultAdapter("v", {});
    const settings = {
      ...DEFAULT_SETTINGS,
      embeddingApiKey: "sk-live-must-not-appear",
      server: { ...DEFAULT_SETTINGS.server, token: "bearer-must-not-appear" },
    };
    const engine = new EngramEngine(adapter, settings, NULL_LOGGER, () => 1);
    await engine.backupSettings(settings);

    const raw = await adapter.read("Claude Code/Config/plugin-settings-backup.json");
    expect(raw).not.toContain("sk-live-must-not-appear");
    expect(raw).not.toContain("bearer-must-not-appear");
    // Still a useful recovery point: the non-secret settings are all there, and
    // the secret fields are present-but-redacted rather than silently dropped.
    const parsed = JSON.parse(raw) as { memoryRoot: string; embeddingApiKey: string };
    expect(parsed.memoryRoot).toBe(DEFAULT_SETTINGS.memoryRoot);
    expect(parsed.embeddingApiKey).toBe("«redacted»");
  });
});

describe("inbox serialization across a settings change", () => {
  const INBOX = "Claude Code/Memory/Inbox/pending-memory.md";

  /** Holds every inbox read open until released, so two read-modify-writes overlap. */
  class GatedVault extends InMemoryVaultAdapter {
    gate: Promise<void> | null = null;
    async read(path: string): Promise<string> {
      const value = await super.read(path);
      if (path === INBOX && this.gate) await this.gate;
      return value;
    }
  }

  async function seedThree(engine: EngramEngine) {
    for (let i = 0; i < 3; i++) {
      await engine.addMemory({ content: `memory number ${i}`, type: "note", project: "proj" });
    }
    return (await engine.getPendingMemory()).entries;
  }

  /**
   * Discarding an entry is a read-modify-write of the whole inbox file, and the
   * engine rebuilds its MemoryWriter on every settings change. When the mutex
   * lived on the writer, the rebuilt one started with an empty chain: a discard
   * still in flight was not waited for, so the next discard read the
   * pre-discard file and wrote back a copy that still contained the entry the
   * first one had removed. A settings commit is debounced while you type, so it
   * can genuinely land between two clicks in the review UI.
   */
  it("does not resurrect an entry when settings commit mid-discard", async () => {
    const adapter = new GatedVault("v", {});
    const settings = { ...DEFAULT_SETTINGS };
    let t = 10_000;
    const engine = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++);
    const entries = await seedThree(engine);

    let release!: () => void;
    adapter.gate = new Promise<void>((resolve) => (release = resolve));
    const first = engine.discardPendingMemory(entries[0]);
    engine.updateSettings({ ...settings, appendOnly: !settings.appendOnly });
    const second = engine.discardPendingMemory(entries[1]);
    // Let both reach their read before either is allowed to finish.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    adapter.gate = null;
    release();
    await Promise.all([first, second]);

    const remaining = (await engine.getPendingMemory()).entries.map((e) => e.content);
    expect(remaining).toEqual(["memory number 2"]);
  });
});

describe("superseded memory", () => {
  const DECISIONS = "Claude Code/Memory/Projects/Engram/decisions.md";
  const REF = `${DECISIONS}#Decision — storage`;

  async function retire(): Promise<ReturnType<typeof makeEngine>> {
    const made = makeEngine({
      [DECISIONS]:
        "## Decision — storage\n\nWe chose SQLite for the durable store.\n\n" +
        "## Decision — ranking\n\nWe chose BM25 for lexical ranking.\n",
      "Notes/unrelated.md": "# Unrelated\nSQLite appears here too, in an ordinary note.",
    });
    await made.engine.reindex();
    await made.engine.addMemory({
      type: "decision",
      content: "We now use a local JSON index instead of SQLite.",
      project: "Engram",
      supersedes: REF,
    });
    const [pending] = (await made.engine.getPendingMemory()).entries;
    const outcome = await made.engine.applyPendingMemory(pending);
    expect(outcome.superseded).toBe("recorded");
    return made;
  }

  it("stops returning the retired section from search, and only that section", async () => {
    const { engine } = await retire();
    const hits = await engine.search({ query: "SQLite durable store" });
    const paths = hits.map((h) => `${h.chunk.notePath}#${h.chunk.heading}`);

    expect(paths).not.toContain(REF);
    // An unrelated note that merely mentions the same words is untouched.
    expect(hits.some((h) => h.chunk.notePath === "Notes/unrelated.md")).toBe(true);
    // And so is the rest of the SAME file — retiring one memory must not blank
    // its neighbours. Asked separately because the query above shares no terms
    // with the sibling section, so its absence there proves nothing.
    const siblings = await engine.search({ query: "BM25 lexical ranking" });
    expect(
      siblings.some((h) => h.chunk.notePath === DECISIONS && h.chunk.heading === "Decision — ranking"),
    ).toBe(true);
  });

  it("strips the retired section from whole-file context reads too", async () => {
    // Filtering search alone would leave the retired memory served through the
    // other door, with nothing to tell it apart from its replacement.
    const { engine } = await retire();
    const parts = await engine.getProjectContext("Engram");
    const decisions = parts.find((p) => p.path === DECISIONS);

    expect(decisions?.content).not.toContain("We chose SQLite for the durable store.");
    expect(decisions?.content).toContain("Decision — storage — superseded");
    expect(decisions?.content).toContain("We chose BM25 for lexical ranking.");
    expect(decisions?.content).toContain("We now use a local JSON index");
  });

  it("refuses a reference that points outside the memory root", async () => {
    // Retiring is a hide, so a reference able to name any vault note would let
    // a proposal quietly retire the user's own writing.
    const { engine } = makeEngine({ "Notes/private.md": "# Private\nsecret" });
    await expect(
      engine.addMemory({ type: "note", content: "x", supersedes: "Notes/private.md#Private" }),
    ).rejects.toThrow(/supersedes/i);
    // Nothing was written: the proposal never reached the inbox.
    expect((await engine.getPendingMemory()).entries).toHaveLength(0);
  });

  it("refuses a reference with no heading", async () => {
    const { engine } = makeEngine({});
    await expect(
      engine.addMemory({ type: "note", content: "x", supersedes: DECISIONS }),
    ).rejects.toThrow(/supersedes/i);
  });
});

describe("index stats report the mode that is actually serving", () => {
  it("says lexical with no provider, and never claims vectors it does not have", async () => {
    // The control panel shows this. The mode alone was how 0.11.2's "says
    // hybrid, serves lexical" looked correct, so the stats carry both.
    const { engine } = makeEngine({ "Notes/a.md": "# A\n\nbody" });
    await engine.reindex();
    const stats = engine.getIndexStats();
    expect(stats.retrievalMode).toBe("lexical");
    expect(stats.vectorsReady).toBe(false);
  });
});

describe("the review ledgers are not search results", () => {
  it("does not serve a discarded proposal back as ordinary memory", async () => {
    // Discarding copies the proposal's content into `rejected-memory.md`, which
    // is indexed like any other note — so the claim the reviewer turned down
    // came back as an unlabelled hit, and its structured record said
    // `pendingReview: false`, asserting it was reviewed memory. That inverts
    // the ledger's purpose: it exists so an agent stops re-proposing what was
    // refused, not so the refusal becomes searchable knowledge. `find_symbol`
    // already excluded these files for this reason; search did not.
    const { engine } = makeEngine({});
    await engine.addMemory({ type: "decision", content: "We will migrate to kokako storage." });
    const [pending] = (await engine.getPendingMemory()).entries;
    await engine.discardPendingMemory(pending, { reason: "Wrong — kokako was rejected." });
    await engine.reindex();

    const hits = await engine.search({ query: "kokako storage" });
    expect(hits.map((h) => h.chunk.notePath)).not.toContain(
      engine.getPaths().rejectedMemoryFile,
    );
    // Still readable through the tool that labels it and carries the reason.
    const { entries } = await engine.getRejectedMemory();
    expect(entries.map((e) => e.content).join("\n")).toContain("kokako storage");
  });

  it("keeps a PENDING proposal searchable, which is the feature", async () => {
    // The pending file is deliberately indexed and labelled `[PENDING REVIEW]`
    // so an agent can see its own proposals. Excluding the whole inbox folder
    // to fix the ledgers would have taken this with it.
    const { engine } = makeEngine({});
    await engine.addMemory({ type: "decision", content: "We will adopt takahe indexing." });
    await engine.reindex();
    const hits = await engine.search({ query: "takahe indexing" });
    expect(hits.map((h) => h.chunk.notePath)).toContain(engine.getPaths().pendingMemoryFile);
  });
});

describe("superseded memory is not served through the note-reading doors", () => {
  const DECISIONS = "Claude Code/Memory/Projects/Engram/decisions.md";

  async function retireStorage() {
    const made = makeEngine({
      [DECISIONS]:
        "## Decision — storage\n\nWe chose SQLite for the durable store.\n\n" +
        "## Decision — ranking\n\nWe chose BM25 for lexical ranking.\n",
    });
    await made.engine.reindex();
    await made.engine.addMemory({
      type: "decision",
      content: "We now use a local JSON index.",
      project: "Engram",
      supersedes: `${DECISIONS}#Decision — storage`,
    });
    const [pending] = (await made.engine.getPendingMemory()).entries;
    expect((await made.engine.applyPendingMemory(pending)).superseded).toBe("recorded");
    return made;
  }

  it("drops the retired section from the chunks a caller may read", async () => {
    // Filtering search and the whole-file context reads alone left this door
    // open: get_note_context and summarize_note both read a note's chunks, so
    // an agent still saw the retired text beside its replacement.
    const { engine } = await retireStorage();
    const readable = await engine.getReadableNoteChunks(DECISIONS);

    expect(readable.some((c) => c.heading === "Decision — storage")).toBe(false);
    expect(readable.some((c) => c.heading === "Decision — ranking")).toBe(true);
    // The raw index accessor is deliberately unfiltered: its other callers ask
    // "is this note indexed?", which a retirement does not change.
    expect(engine.getNoteChunks(DECISIONS).some((c) => c.heading === "Decision — storage")).toBe(
      true,
    );
  });

  it("keeps the retired text out of a summary", async () => {
    const { engine } = await retireStorage();
    const summary = await engine.summarizeNote(DECISIONS);
    expect(summary.sentences.join(" ")).not.toContain("SQLite");
  });

  it("says a fully-retired note is retired, not unindexed", async () => {
    // Two different empties needing different answers: reporting this as "not
    // indexed" would send the agent to reindex a note that is indexed and
    // deliberately empty of servable content.
    const made = makeEngine({ [DECISIONS]: "## Decision — storage\n\nWe chose SQLite.\n" });
    await made.engine.reindex();
    await made.engine.addMemory({
      type: "decision",
      content: "Replacement.",
      project: "Engram",
      supersedes: `${DECISIONS}#Decision — storage`,
    });
    const [pending] = (await made.engine.getPendingMemory()).entries;
    await made.engine.applyPendingMemory(pending);
    // Re-index so the applied block is not itself a servable chunk.
    await made.adapter.write(DECISIONS, "## Decision — storage\n\nWe chose SQLite.\n");
    await made.engine.reindex();

    await expect(made.engine.summarizeNote(DECISIONS)).rejects.toThrow(/superseded/i);
    // The note-reading door had its own copy of this refusal and knew only one
    // of the two empties, so it told the agent to reindex a note that IS
    // indexed and deliberately empty — the engine owns the distinction now.
    expect(made.engine.unservableNote(DECISIONS, 0, "read")).toMatch(/superseded/i);
    expect(made.engine.unservableNote("Notes/never-existed.md", 0, "read")).toMatch(
      /not indexed/i,
    );
    expect(made.engine.unservableNote(DECISIONS, 3, "read")).toBeNull();
  });
});

describe("a memory with an unbalanced code fence cannot hide its neighbours", () => {
  it("retires only the named memory, not everything applied after it", async () => {
    // The reported attack: applied content lands in the memory file verbatim,
    // so an odd number of fence markers desynchronizes every fence-aware reader
    // from that point to the end of the file. Retiring that memory then found
    // no heading to stop at and swallowed every later section — silently, and
    // only in the context reads, so search still showed the "missing" text.
    const { engine } = makeEngine({});
    await engine.reindex();

    const propose = async (content: string, supersedes?: string) => {
      await engine.addMemory({ type: "decision", content, project: "Engram", supersedes });
      const entries = (await engine.getPendingMemory()).entries;
      return engine.applyPendingMemory(entries[entries.length - 1]);
    };

    await propose("Storage plan:\n\n```sh\nsqlite3 memory.db");
    await propose("Ranking uses BM25 with a heading boost.");

    const decisions = "Claude Code/Memory/Projects/Engram/decisions.md";
    const before = await engine.getProjectContext("Engram");
    const stale = before.find((p) => p.path === decisions)!.content;
    const staleHeading = /^## (Decision — .*)$/m.exec(stale)![1];

    expect((await propose("Storage is now a JSON index.", `${decisions}#${staleHeading}`)).superseded)
      .toBe("recorded");

    const after = (await engine.getProjectContext("Engram")).find((p) => p.path === decisions)!;
    expect(after.content).not.toContain("sqlite3 memory.db");
    // The neighbour applied between them survives — that is the whole point.
    expect(after.content).toContain("Ranking uses BM25 with a heading boost.");
    expect(after.content).toContain("Storage is now a JSON index.");
  });
});

describe("overlap with existing memory, flagged at propose time", () => {
  const DECISIONS = "Claude Code/Memory/Projects/Engram/decisions.md";

  async function seeded() {
    const made = makeEngine({
      [DECISIONS]:
        "## Decision — storage\n\n" +
        "We chose SQLite for the durable memory store because it needs no native build.\n",
      "Notes/blog.md":
        "# Blog\nWe chose SQLite for the durable memory store because it needs no native build.",
    });
    await made.engine.reindex();
    return made;
  }

  it("names the memory a contradicting proposal covers, and records it on the block", async () => {
    const { engine, adapter } = await seeded();
    const { similarTo } = await engine.addMemory({
      type: "decision",
      content: "We chose Postgres for the durable memory store because it needs no native build.",
      project: "Engram",
    });

    expect(similarTo).toBe(`${DECISIONS}#Decision — storage`);
    expect(await adapter.read("Claude Code/Memory/Inbox/pending-memory.md")).toContain(
      `Similar: ${DECISIONS}#Decision — storage`,
    );
  });

  it("looks only inside memory, not at ordinary vault notes", async () => {
    // A blog post repeating a decision is not a memory this could ever
    // supersede, so pointing at it would be advice the agent cannot act on.
    const { engine } = await seeded();
    const { similarTo } = await engine.addMemory({
      type: "decision",
      content: "We chose Postgres for the durable memory store because it needs no native build.",
    });
    expect(similarTo).not.toContain("Notes/blog.md");
  });

  it("ignores unreviewed proposals sitting in the inbox", async () => {
    // Overlapping a proposal nobody has approved is not news, and `supersedes`
    // cannot name something that is not memory yet.
    const { engine } = await seeded();
    const first = "Retrieval fuses lexical and vector lists with reciprocal rank fusion always.";
    await engine.addMemory({ type: "decision", content: first, project: "Engram" });
    await engine.reindex();

    const { similarTo } = await engine.addMemory({
      type: "decision",
      content: `${first} And the constant is sixty.`,
      project: "Engram",
    });
    expect(similarTo === undefined || !similarTo.includes("Inbox")).toBe(true);
  });

  it("stays quiet when the proposal already says what it replaces", async () => {
    const { engine } = await seeded();
    const { similarTo } = await engine.addMemory({
      type: "decision",
      content: "We chose Postgres for the durable memory store because it needs no native build.",
      project: "Engram",
      supersedes: `${DECISIONS}#Decision — storage`,
    });
    expect(similarTo).toBeUndefined();
  });

  it("never fails a proposal when the check cannot run", async () => {
    // It sits in a write path. A memory that reaches the inbox is worth more
    // than an advisory that did not.
    const { engine } = await seeded();
    const broken = engine as unknown as { retriever: { retrieve: () => never } };
    const original = broken.retriever;
    broken.retriever = {
      retrieve: () => {
        throw new Error("retriever exploded");
      },
    };
    const result = await engine.addMemory({ type: "note", content: "A perfectly good memory." });
    broken.retriever = original;

    expect(result.duplicate).toBe(false);
    expect(result.similarTo).toBeUndefined();
    expect((await engine.getPendingMemory()).entries).toHaveLength(1);
  });
});

describe("a direct write carries no review-time annotation", () => {
  it("does not bake the overlap note into a memory file nobody reviews", async () => {
    // The annotation exists to be read at review time. A direct write has no
    // review, so writing it there would leave a permanent "Similar: …" line in
    // a memory file that nobody was given the chance to act on — reporting
    // turned into an unreviewed edit.
    const decisions = "Claude Code/Memory/Projects/Engram/decisions.md";
    const adapter = new InMemoryVaultAdapter("v", {
      [decisions]:
        "## Decision — storage\n\n" +
        "We chose SQLite for the durable memory store because it needs no native build.\n",
    });
    let t = 10_000;
    const engine = new EngramEngine(
      adapter,
      { ...DEFAULT_SETTINGS, allowDirectWrites: true },
      NULL_LOGGER,
      () => t++,
    );
    await engine.reindex();

    const target = "Memory/Projects/Engram/decisions.md";
    const { path } = await engine.addMemory(
      {
        type: "decision",
        content:
          "We chose Postgres for the durable memory store because it needs no native build.",
        project: "Engram",
      },
      { direct: true, subpath: target },
    );

    expect(path).toBe(decisions);
    const written = await adapter.read(decisions);
    expect(written).toContain("We chose Postgres");
    expect(written).not.toContain("Similar:");
  });

  it("still annotates the same proposal when it goes to the inbox", async () => {
    // The guard is on the direct path only — the review path must keep it.
    const decisions = "Claude Code/Memory/Projects/Engram/decisions.md";
    const { engine } = makeEngine({
      [decisions]:
        "## Decision — storage\n\n" +
        "We chose SQLite for the durable memory store because it needs no native build.\n",
    });
    await engine.reindex();
    const { similarTo } = await engine.addMemory({
      type: "decision",
      content: "We chose Postgres for the durable memory store because it needs no native build.",
      project: "Engram",
    });
    expect(similarTo).toBe(`${decisions}#Decision — storage`);
  });
});

describe("memory ageing in search", () => {
  const DECISIONS = "Claude Code/Memory/Projects/Engram/decisions.md";
  const seed = {
    [DECISIONS]:
      "## Decision — 2020-01-01 09:00 · aaa\n\n" +
      "We chose SQLite for the durable memory store.\n\n" +
      "## Decision — 2026-08-01 09:00 · bbb\n\n" +
      "We chose SQLite for the durable memory store, with WAL enabled.\n",
    "Notes/ancient.md": "# Ancient\nWe chose SQLite for the durable memory store, long ago.",
  };

  function engineWith(halfLife: number) {
    const adapter = new InMemoryVaultAdapter("v", seed);
    // A clock in the present, so the 2020 heading really is old.
    const now = new Date(2026, 7, 20, 12, 0).getTime();
    return new EngramEngine(
      adapter,
      { ...DEFAULT_SETTINGS, memoryDecayHalfLifeDays: halfLife },
      NULL_LOGGER,
      () => now,
    );
  }

  it("puts the recent memory first once ageing is on, and not before", async () => {
    const off = engineWith(0);
    await off.reindex();
    const baseline = await off.search({ query: "SQLite durable memory store" });
    const baselineFirstMemory = baseline.find((r) => r.chunk.notePath === DECISIONS)!;
    expect(baselineFirstMemory.chunk.heading).toContain("2020-01-01");

    const on = engineWith(90);
    await on.reindex();
    const aged = await on.search({ query: "SQLite durable memory store" });
    const agedFirstMemory = aged.find((r) => r.chunk.notePath === DECISIONS)!;
    expect(agedFirstMemory.chunk.heading).toContain("2026-08-01");
  });

  it("never drops an old memory out of the results entirely", async () => {
    // Ageing orders memory; a memory you cannot retrieve is one you have lost.
    const on = engineWith(1);
    await on.reindex();
    const aged = await on.search({ query: "SQLite durable memory store" });
    expect(aged.some((r) => r.chunk.heading.includes("2020-01-01"))).toBe(true);
  });

  it("leaves an ordinary note's score alone", async () => {
    const off = engineWith(0);
    await off.reindex();
    const before = (await off.search({ query: "SQLite durable memory store" })).find(
      (r) => r.chunk.notePath === "Notes/ancient.md",
    )!;

    const on = engineWith(30);
    await on.reindex();
    const after = (await on.search({ query: "SQLite durable memory store" })).find(
      (r) => r.chunk.notePath === "Notes/ancient.md",
    )!;
    expect(after.score).toBeCloseTo(before.score, 10);
  });
});

describe("code symbols", () => {
  const DEFINITION =
    "# Utils\n\n```ts\nexport function resolveInVault(root: string, sub: string) {\n" +
    "  return join(root, sub);\n}\n```\n";
  const MENTIONS =
    "# Notes on paths\n\nresolveInVault is important. We call resolveInVault everywhere. " +
    "Always resolveInVault before writing. Never skip resolveInVault. resolveInVault again.\n";

  it("ranks the declaration above a note that merely mentions it more often", async () => {
    // The point of the whole stage: term frequency alone put the chattiest
    // passage first, and for an identifier the declaration is what you wanted.
    //
    // Filler notes are not padding: the symbol credit scales with IDF, so in a
    // two-document corpus where the term appears in both, IDF is near zero and
    // every weight is near zero with it. A corpus where the name is actually
    // rare is the condition this feature is for, and the only one where the
    // measurement means anything.
    const seed: Record<string, string> = {
      "Code/utils.md": DEFINITION,
      "Notes/chatter.md": MENTIONS,
    };
    for (let i = 0; i < 12; i++) {
      seed[`Notes/filler-${i}.md`] = `# Filler ${i}\nUnrelated prose about other matters.`;
    }
    const { engine } = makeEngine(seed);
    await engine.reindex();
    const hits = await engine.search({ query: "resolveInVault" });
    expect(hits[0].chunk.notePath).toBe("Code/utils.md");
  });

  it("records the symbols a chunk declares, and nothing from prose", async () => {
    const { engine } = makeEngine({
      "Code/utils.md": DEFINITION,
      "Notes/chatter.md": MENTIONS,
    });
    await engine.reindex();
    expect(engine.getNoteChunks("Code/utils.md")[0].symbols).toContain("resolveInVault");
    expect(engine.getNoteChunks("Notes/chatter.md")[0].symbols).toEqual([]);
  });

  it("finds a definition by exact name, and says so when there is none", async () => {
    const { engine } = makeEngine({
      "Code/utils.md": DEFINITION,
      "Notes/chatter.md": MENTIONS,
    });
    await engine.reindex();

    const found = await engine.findSymbol("resolveInVault", 5);
    expect(found).toHaveLength(1);
    expect(found[0].notePath).toBe("Code/utils.md");

    // Case-folded like every other name comparison here.
    expect(await engine.findSymbol("RESOLVEINVAULT", 5)).toHaveLength(1);
    // But a mention is not a declaration.
    expect(await engine.findSymbol("chatter", 5)).toEqual([]);
    expect(await engine.findSymbol("   ", 5)).toEqual([]);
  });

  it("does not return a declaration inside a retired memory", async () => {
    const decisions = "Claude Code/Memory/Projects/Engram/decisions.md";
    const { engine } = makeEngine({
      [decisions]: "## Decision — api\n\n```ts\nfunction oldApi() {}\n```\n",
    });
    await engine.reindex();
    await engine.addMemory({
      type: "decision",
      content: "The API changed.",
      project: "Engram",
      supersedes: `${decisions}#Decision — api`,
    });
    const [pending] = (await engine.getPendingMemory()).entries;
    expect((await engine.applyPendingMemory(pending)).superseded).toBe("recorded");

    expect(await engine.findSymbol("oldApi", 5)).toEqual([]);
  });
});
