import { describe, it, expect } from "vitest";
import { ObsidianVaultAdapter } from "../src/core/obsidian-vault-adapter";
import type { App } from "obsidian";
import { NULL_LOGGER } from "../src/utils/logger";

/**
 * `ObsidianVaultAdapter.write` does a temp-file → move-old-aside → rename dance
 * whose entire point is that a FAILED write is never a destructive one: the
 * user's memory files are durable content, and a rename that fails partway (a
 * Windows file lock from a sync client or antivirus is the usual cause) must
 * not leave them with nothing.
 *
 * That property was previously exercised only by the Playwright e2e harness,
 * which needs a real Obsidian install and does not run in CI — so the whole
 * dance could regress to a naive "delete then write" and every `npm test` would
 * still pass. These tests drive the REAL adapter against a controllable fake
 * `app.vault.adapter`, rather than asserting against a second copy of the logic
 * living in a test double.
 *
 * They complement rather than replace the e2e coverage: actual crash timing and
 * Obsidian's real `normalizePath` still belong there.
 */

interface FakeOpts {
  /** Return true to make this particular rename throw. */
  failRename?: (from: string, to: string) => boolean;
  /** Value the failing rename throws. Defaults to a real Error. */
  rejectWith?: unknown;
}

function makeApp(opts: FakeOpts = {}) {
  const files = new Map<string, string>();
  const vaultAdapter = {
    async exists(p: string) {
      // Yields to the microtask queue, as real I/O does: without this a
      // check-then-act race cannot be modelled at all, because the check and
      // the act run in one uninterrupted tick.
      await Promise.resolve();
      // True for a FOLDER too, as the host's `exists` is: a folder is present
      // whenever anything lives under it. The fake once knew only files, which
      // made a root full of files report as missing.
      if (files.has(p)) return true;
      const prefix = `${p}/`;
      for (const k of files.keys()) if (k.startsWith(prefix)) return true;
      return false;
    },
    async read(p: string) {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    async write(p: string, c: string) {
      files.set(p, c);
    },
    // Obsidian's adapter appends to an EXISTING file; the adapter under test
    // handles the create case itself, which is exactly where the race lives.
    async append(p: string, c: string) {
      await Promise.resolve();
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      files.set(p, v + c);
    },
    async rename(from: string, to: string) {
      if (opts.failRename?.(from, to)) {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal -- deliberately models a host API rejecting with a non-Error
        throw "rejectWith" in opts ? opts.rejectWith : new Error("simulated rename failure");
      }
      const v = files.get(from);
      if (v === undefined) throw new Error(`ENOENT: ${from}`);
      files.set(to, v);
      files.delete(from);
    },
    async remove(p: string) {
      files.delete(p);
    },
    async mkdir() {},
    async stat() {
      return null;
    },
    // Full paths, as Obsidian's FileSystemAdapter returns them; the adapter
    // under test accepts bare names too, so this shape is not load-bearing.
    async list(folder: string) {
      const prefix = folder === "" ? "" : `${folder}/`;
      const files: string[] = [];
      const folders = new Set<string>();
      for (const k of files_.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) files.push(k);
        else folders.add(prefix + rest.slice(0, slash));
      }
      return { files, folders: [...folders] };
    },
  };
  const files_ = files;
  const app = { vault: { adapter: vaultAdapter, getName: () => "v" } } as unknown as App;
  return { app, files };
}

const debris = (files: Map<string, string>) =>
  [...files.keys()].filter((k) => k.includes(".engram-tmp-") || k.includes(".engram-bak-"));

describe("ObsidianVaultAdapter.write crash safety", () => {
  it("writes normally and leaves no temp or backup files behind", async () => {
    const { app, files } = makeApp();
    const adapter = new ObsidianVaultAdapter(app);

    await adapter.write("Notes/a.md", "first");
    expect(files.get("Notes/a.md")).toBe("first");

    await adapter.write("Notes/a.md", "second");
    expect(files.get("Notes/a.md")).toBe("second");
    expect(debris(files)).toEqual([]);
  });

  it("keeps the original intact when the final rename fails", async () => {
    // The destructive-failure case: the old file has already been moved aside
    // when the rename into place fails. A naive implementation deletes the
    // original first and loses it here.
    let armed = false;
    const { app, files } = makeApp({
      failRename: (from, to) => armed && to === "Notes/a.md" && from.includes(".engram-tmp-"),
    });
    const adapter = new ObsidianVaultAdapter(app);
    await adapter.write("Notes/a.md", "original");
    armed = true; // only the SECOND write's rename-into-place fails

    await expect(adapter.write("Notes/a.md", "replacement")).rejects.toThrow(/simulated/);

    expect(files.get("Notes/a.md"), "the original content must survive a failed write").toBe(
      "original",
    );
    expect(debris(files), "a failed write must not litter the vault").toEqual([]);
  });

  it("keeps BOTH copies and names them when even the restore fails", async () => {
    // Worst case: the rename into place fails AND putting the original back
    // fails too. Losing data is not an option, so both copies are kept and the
    // error says exactly where they are.
    //
    // The predicate must fail ONLY the renames whose destination is the target
    // — the into-place move and the restore-back — and must let the
    // move-the-original-aside rename succeed. An earlier version of this test
    // used `from.includes(".engram-") === false || true`, which is a tautology:
    // it failed the very first rename instead, so this test exercised the same
    // branch as the one below it and the dual-copy path had no coverage at all.
    const { app, files } = makeApp({ failRename: (_from, to) => to === "Notes/a.md" });
    const adapter = new ObsidianVaultAdapter(app);
    // Seed the target directly so the first write's own rename isn't involved.
    files.set("Notes/a.md", "original");

    await expect(adapter.write("Notes/a.md", "replacement")).rejects.toThrow(
      /previous content is at.*new content is at/s,
    );

    // Neither copy may be discarded: the original is parked in the backup and
    // the new content is parked in the temp file, and the error named both.
    const backup = [...files.keys()].find((k) => k.includes(".engram-bak-"));
    const tmp = [...files.keys()].find((k) => k.includes(".engram-tmp-"));
    expect(backup, "the original must be preserved somewhere").toBeDefined();
    expect(tmp, "the new content must be preserved somewhere").toBeDefined();
    expect(files.get(backup!)).toBe("original");
    expect(files.get(tmp!)).toBe("replacement");
  });

  it("cleans up the temp file when moving the old copy aside fails", async () => {
    const { app, files } = makeApp({
      failRename: (from) => from === "Notes/a.md",
    });
    const adapter = new ObsidianVaultAdapter(app);
    files.set("Notes/a.md", "original");

    await expect(adapter.write("Notes/a.md", "replacement")).rejects.toThrow(/simulated/);

    expect(files.get("Notes/a.md")).toBe("original");
    expect(debris(files), "the temp file must not be left behind").toEqual([]);
  });

  it("rethrows a non-Error host rejection as an Error", async () => {
    // Obsidian's adapter is a host API: nothing guarantees it rejects with an
    // Error, and every caller here treats a failure as one. A bare `throw err`
    // propagated the raw value, so a rejected string arrived as a string and
    // `toMessage`/`.message` on it produced nothing useful.
    const { app, files } = makeApp({
      failRename: (from) => from === "Notes/a.md",
      rejectWith: "EPERM: operation not permitted",
    });
    const adapter = new ObsidianVaultAdapter(app);
    files.set("Notes/a.md", "original");

    const err = await adapter.write("Notes/a.md", "replacement").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("EPERM: operation not permitted");
    // The crash-safety guarantee is unchanged by the normalization.
    expect(files.get("Notes/a.md")).toBe("original");
    expect(debris(files)).toEqual([]);
  });

  it("refuses an absolute path at the adapter boundary", async () => {
    // The adapter is defense-in-depth, not the choke-point: it refuses
    // absolute paths only, and `..` rejection deliberately lives upstream in
    // `resolveInVault` (see paths.test.ts), which every caller routes through.
    // Asserting `..` here would encode a guarantee this layer does not make.
    const { app } = makeApp();
    const adapter = new ObsidianVaultAdapter(app);
    await expect(adapter.write("/etc/passwd", "x")).rejects.toThrow(/non-relative/);
    await expect(adapter.write("C:\\Windows\\x", "x")).rejects.toThrow(/non-relative/);
    await expect(adapter.read("/etc/passwd")).rejects.toThrow(/non-relative/);
  });
});

describe("ObsidianVaultAdapter.append", () => {
  it("never lets one append overwrite another when the file is new", async () => {
    // The create branch is a check-then-act: two concurrent appends to a file
    // that does not exist YET both saw `exists() === false` and both took the
    // `write` path, so the second silently replaced the first. An append that
    // overwrites is the one thing an append must never do, and the review inbox
    // and the memory files are append-only by design.
    //
    // Reachable without any lock of its own from `MemoryWriter.directWrite`'s
    // append-only branch and from `endSession`.
    const { app, files } = makeApp();
    const adapter = new ObsidianVaultAdapter(app);
    await Promise.all([
      adapter.append("Claude Code/Memory/Global/notes.md", "first\n"),
      adapter.append("Claude Code/Memory/Global/notes.md", "second\n"),
    ]);
    const body = files.get("Claude Code/Memory/Global/notes.md") ?? "";
    expect(body).toContain("first");
    expect(body).toContain("second");
  });

  it("still appends to a file that already exists", async () => {
    const { app, files } = makeApp();
    const adapter = new ObsidianVaultAdapter(app);
    await adapter.append("Claude Code/Memory/Global/notes.md", "one\n");
    await adapter.append("Claude Code/Memory/Global/notes.md", "two\n");
    expect(files.get("Claude Code/Memory/Global/notes.md")).toBe("one\ntwo\n");
  });
});

describe("ObsidianVaultAdapter.recoverInterruptedWrites", () => {
  const ROOT = "Claude Code";
  const NOTE = "Claude Code/Memory/Global/profile.md";

  it("restores a backup whose target is missing — the crash window itself", async () => {
    // `write` renames the live file to `X.engram-bak-<stamp>` before renaming
    // the new content into place. A process killed between those two renames
    // leaves NO file at X, and until now nothing on startup looked for it.
    const { app, files } = makeApp();
    files.set(`${NOTE}.engram-bak-1700000000000-1`, "the user's content");
    const out = await new ObsidianVaultAdapter(app).recoverInterruptedWrites(ROOT);
    expect(files.get(NOTE)).toBe("the user's content");
    expect(out.restored).toEqual([`${NOTE}.engram-bak-1700000000000-1`]);
    expect(debris(files)).toEqual([]);
  });

  it("removes a backup whose target exists — the success path's lost cleanup", async () => {
    const { app, files } = makeApp();
    files.set(NOTE, "current");
    files.set(`${NOTE}.engram-bak-1700000000000-1`, "older");
    const out = await new ObsidianVaultAdapter(app).recoverInterruptedWrites(ROOT);
    expect(files.get(NOTE)).toBe("current");
    expect(out.removed).toEqual([`${NOTE}.engram-bak-1700000000000-1`]);
    expect(debris(files)).toEqual([]);
  });

  it("restores the backup and drops the temp when a crash left both", async () => {
    // Both present and no target means the crash fell between the two renames:
    // the temp holds the completed NEW content, the backup the old. The old
    // content is the honest outcome — the write was never reported as done.
    const { app, files } = makeApp();
    files.set(`${NOTE}.engram-bak-1700000000000-1`, "old");
    files.set(`${NOTE}.engram-tmp-1700000000000-1`, "new but never confirmed");
    await new ObsidianVaultAdapter(app).recoverInterruptedWrites(ROOT);
    expect(files.get(NOTE)).toBe("old");
    expect(debris(files)).toEqual([]);
  });

  it("removes an orphaned temp file and leaves its target alone", async () => {
    const { app, files } = makeApp();
    files.set(NOTE, "current");
    files.set(`${NOTE}.engram-tmp-1700000000000-1`, "partial");
    await new ObsidianVaultAdapter(app).recoverInterruptedWrites(ROOT);
    expect(files.get(NOTE)).toBe("current");
    expect(debris(files)).toEqual([]);
  });

  it("restores the newest of several backups and removes the rest", async () => {
    const { app, files } = makeApp();
    files.set(`${NOTE}.engram-bak-1700000000000-1`, "older");
    files.set(`${NOTE}.engram-bak-1700000005000-1`, "newer");
    await new ObsidianVaultAdapter(app).recoverInterruptedWrites(ROOT);
    expect(files.get(NOTE)).toBe("newer");
    expect(debris(files)).toEqual([]);
  });

  it("touches nothing outside the root, and nothing that merely resembles a leftover", async () => {
    const { app, files } = makeApp();
    files.set("Notes/mine.md.engram-bak-1700000000000-1", "not ours to touch");
    files.set("Claude Code/Memory/Global/notes.engram-bak-plan.md", "a real note with an odd name");
    files.set("Claude Code/Memory/Global/profile.md", "current");
    const out = await new ObsidianVaultAdapter(app).recoverInterruptedWrites(ROOT);
    expect(out).toEqual({ restored: [], removed: [] });
    expect(files.get("Notes/mine.md.engram-bak-1700000000000-1")).toBe("not ours to touch");
    expect(files.get("Claude Code/Memory/Global/notes.engram-bak-plan.md")).toBe("a real note with an odd name");
  });

  it("is silent on a fresh vault whose root does not exist yet", async () => {
    // Listing a missing folder throws; without the guard every first run
    // logged "Recovery could not list a folder" for a root nothing had created.
    const { app } = makeApp();
    const warnings: string[] = [];
    const logger = {
      ...NULL_LOGGER,
      warn: (message: string) => {
        warnings.push(message);
      },
    };
    const out = await new ObsidianVaultAdapter(app).recoverInterruptedWrites(ROOT, logger);
    expect(out).toEqual({ restored: [], removed: [] });
    expect(warnings).toEqual([]);
  });

  it("never throws: a repair that fails is logged and skipped", async () => {
    const { app, files } = makeApp({ failRename: () => true });
    files.set(`${NOTE}.engram-bak-1700000000000-1`, "content");
    const out = await new ObsidianVaultAdapter(app).recoverInterruptedWrites(ROOT);
    expect(out.restored).toEqual([]);
    // The backup is still there — a failed restore must not become a delete.
    expect(files.get(`${NOTE}.engram-bak-1700000000000-1`)).toBe("content");
  });
});
