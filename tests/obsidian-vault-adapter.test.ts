import { describe, it, expect } from "vitest";
import { ObsidianVaultAdapter } from "../src/core/obsidian-vault-adapter";
import type { App } from "obsidian";

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
      return files.has(p);
    },
    async read(p: string) {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    async write(p: string, c: string) {
      files.set(p, c);
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
  };
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
