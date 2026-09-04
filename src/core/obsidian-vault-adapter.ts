/**
 * ObsidianVaultAdapter — the production VaultAdapter, backed by Obsidian's
 * Vault API. This is the ONLY service-layer file permitted to import
 * `obsidian`. All paths are assumed pre-validated by callers; this adapter
 * additionally refuses absolute paths and uses temp+rename for safer writes.
 */

import { App, normalizePath } from "obsidian";
import { VaultAdapter, VaultFile, assertRelative } from "./vault-adapter";
import { joinVaultPath } from "../utils/paths";
import { asError, toMessage } from "../utils/errors";
import { Logger, NULL_LOGGER } from "../utils/logger";

let tempCounter = 0;

export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private readonly app: App) {}

  vaultName(): string {
    return this.app.vault.getName();
  }

  async read(path: string): Promise<string> {
    assertRelative(path);
    return this.app.vault.adapter.read(normalizePath(path));
  }

  async exists(path: string): Promise<boolean> {
    assertRelative(path);
    return this.app.vault.adapter.exists(normalizePath(path));
  }

  async write(path: string, content: string): Promise<void> {
    assertRelative(path);
    const target = normalizePath(path);
    await this.ensureParentFolder(target);

    // Write to a temp sibling then rename, so a crash mid-write cannot leave a
    // half-written durable file. Rename within the same folder is atomic on
    // typical filesystems.
    // Unique temp suffix so concurrent writes to the same target don't collide.
    const stamp = `${Date.now()}-${tempCounter++}`;
    const tmp = `${target}.engram-tmp-${stamp}`;
    const adapter = this.app.vault.adapter;
    await adapter.write(tmp, content);

    // Obsidian's rename refuses an existing target, so the old file has to go
    // first — but REMOVING it leaves a window in which neither copy is durable.
    // A rename that then fails (a Windows file lock from a sync client or
    // antivirus is the usual cause) used to delete the temp file too, turning a
    // failed write into the loss of a file the user still had. Move the old
    // copy aside instead, and put it back if anything goes wrong.
    const backup = (await adapter.exists(target)) ? `${target}.engram-bak-${stamp}` : null;
    try {
      if (backup) await adapter.rename(target, backup);
    } catch (err) {
      await adapter.remove(tmp).catch(() => undefined);
      throw asError(err);
    }
    try {
      await adapter.rename(tmp, target);
    } catch (err) {
      // Restore the original. If even that fails, keep BOTH copies and say
      // where they are — never leave the user with nothing.
      if (backup) {
        const restored = await adapter
          .rename(backup, target)
          .then(() => true)
          .catch(() => false);
        if (!restored) {
          throw new Error(
            `Failed to write "${target}": ${toMessage(err)}. ` +
              `The previous content is at "${backup}" and the new content is at "${tmp}".`,
          );
        }
      }
      await adapter.remove(tmp).catch(() => undefined);
      throw asError(err);
    }
    // The write is durable; the backup is now just garbage.
    if (backup) await adapter.remove(backup).catch(() => undefined);
  }

  /**
   * Appends are serialized against each other, process-wide.
   *
   * The create branch below is a check-then-act: Obsidian's `append` needs the
   * file to exist, so a missing one is written instead. Two concurrent appends
   * to a file that did not exist YET both saw `exists() === false` and both
   * took the write path, so the second silently replaced the first — an append
   * that overwrote, which is the one thing an append must never do, and memory
   * files and the review inbox are append-only by design. `directWrite`'s
   * append-only branch and `endSession` both reach here with no lock of their
   * own.
   *
   * One chain rather than one per path: appends are small, infrequent, and
   * always the plugin's own writes, so the contention this gives up is not
   * worth a map of chains to leak. Same shape as the engine's index chain.
   */
  private appendChain: Promise<unknown> = Promise.resolve();

  async append(path: string, content: string): Promise<void> {
    const run = this.appendChain.then(
      () => this.appendNow(path, content),
      () => this.appendNow(path, content),
    );
    this.appendChain = run.catch(() => undefined);
    return run;
  }

  private async appendNow(path: string, content: string): Promise<void> {
    assertRelative(path);
    const target = normalizePath(path);
    await this.ensureParentFolder(target);
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(target)) {
      await adapter.append(target, content);
    } else {
      await adapter.write(target, content);
    }
  }

  /**
   * Repair what an interrupted `write` left behind, under `root` only.
   *
   * `write` parks the live file at `X.engram-bak-<stamp>` before renaming the
   * new content into place. A process killed between those two renames leaves
   * NO file at `X`: the user's content is intact but under a name nothing
   * reads, and until this existed nothing on startup ever looked for it — the
   * note simply vanished from Obsidian's eyes until a human renamed it back.
   *
   * Three cases, decided per leftover and never by guessing:
   *   - a backup whose target is MISSING is restored (rename back). This is the
   *     crash window itself, and restoring the OLD content is the honest
   *     outcome — the write was never reported as having succeeded.
   *   - a backup whose target EXISTS is removed: the write completed and only
   *     the best-effort cleanup at its end was lost. This is exactly what that
   *     cleanup does on the success path.
   *   - a temp file is removed. It is either an incomplete write (crash before
   *     the swap — target untouched) or the completed new content of a write
   *     whose backup was just restored; either way it is not the file of
   *     record.
   * Backups are handled before temps, so a crash that left both never has the
   * temp deleted while the target is still missing.
   *
   * Scoped to the plugin's own root because that is the only place `write`
   * ever lands, and every step is wrapped: a repair that fails is logged and
   * skipped, never thrown — this runs at plugin load, where a throw would
   * cost the user the plugin. `list()` entries are accepted as either full
   * paths or bare names, since the host API documents neither.
   */
  async recoverInterruptedWrites(
    root: string,
    logger: Logger = NULL_LOGGER,
  ): Promise<{ restored: string[]; removed: string[] }> {
    assertRelative(root);
    const adapter = this.app.vault.adapter;
    const restored: string[] = [];
    const removed: string[] = [];
    const leftovers: Array<{ path: string; target: string; kind: "tmp" | "bak" }> = [];
    // A fresh vault has no root yet: nothing to repair, and not a warning —
    // listing a missing folder throws, and that would have logged "could not
    // list" on every first run.
    if (!(await adapter.exists(normalizePath(root)))) return { restored, removed };

    const walk = async (folder: string): Promise<void> => {
      let listing: { files: string[]; folders: string[] };
      try {
        listing = await adapter.list(folder);
      } catch (err) {
        logger.warn("Recovery could not list a folder", { folder, error: toMessage(err) });
        return;
      }
      // The host documents neither shape. An entry that already carries a
      // separator is a full path (everything under the root has one); a bare
      // name is joined through the same choke-point every other vault path
      // passes, never by concatenation.
      const inFolder = (entry: string) => (entry.includes("/") ? entry : joinVaultPath(folder, entry));
      for (const f of listing.files) {
        const p = inFolder(f);
        const m = /^(.+)\.engram-(tmp|bak)-\d+-\d+$/.exec(p);
        if (m) leftovers.push({ path: p, target: m[1], kind: m[2] as "tmp" | "bak" });
      }
      for (const sub of listing.folders) await walk(inFolder(sub));
    };
    await walk(normalizePath(root));

    const attempt = async (what: string, path: string, op: () => Promise<void>, into: string[]) => {
      try {
        await op();
        into.push(path);
      } catch (err) {
        logger.warn(`Recovery could not ${what}`, { path, error: toMessage(err) });
      }
    };
    // Newest first, so if a target has more than one backup the most recent
    // is the one restored and the older ones are the ones removed.
    const baks = leftovers.filter((l) => l.kind === "bak").sort((a, b) => b.path.localeCompare(a.path));
    for (const bak of baks) {
      if (await adapter.exists(bak.target)) {
        await attempt("remove a stale backup", bak.path, () => adapter.remove(bak.path), removed);
      } else {
        await attempt("restore a backup", bak.path, () => adapter.rename(bak.path, bak.target), restored);
      }
    }
    for (const tmp of leftovers.filter((l) => l.kind === "tmp")) {
      await attempt("remove a temp file", tmp.path, () => adapter.remove(tmp.path), removed);
    }
    if (restored.length > 0 || removed.length > 0) {
      logger.warn("Recovered from an interrupted write", { restored, removed });
    }
    return { restored, removed };
  }

  async ensureFolder(path: string): Promise<void> {
    assertRelative(path);
    await this.createFolderRecursive(normalizePath(path));
  }

  async listMarkdownFiles(): Promise<VaultFile[]> {
    return this.app.vault.getMarkdownFiles().map((f) => ({
      path: f.path,
      mtime: f.stat.mtime,
      size: f.stat.size,
    }));
  }

  async listFilesByExtension(extensions: string[]): Promise<VaultFile[]> {
    const exts = extensions.map((e) => e.replace(/^\./, "").toLowerCase());
    return this.app.vault
      .getFiles()
      .filter((f) => exts.includes(f.extension.toLowerCase()))
      .map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    assertRelative(path);
    return this.app.vault.adapter.readBinary(normalizePath(path));
  }

  async getMtime(path: string): Promise<number | null> {
    assertRelative(path);
    const stat = await this.app.vault.adapter.stat(normalizePath(path));
    return stat ? stat.mtime : null;
  }

  private async ensureParentFolder(target: string): Promise<void> {
    const idx = target.lastIndexOf("/");
    if (idx <= 0) return;
    await this.createFolderRecursive(target.slice(0, idx));
  }

  private async createFolderRecursive(folder: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const parts = folder.split("/").filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      // eslint-disable-next-line no-await-in-loop -- each path segment must exist before the next is created, so these are inherently ordered
      if (!(await adapter.exists(acc))) {
        // eslint-disable-next-line no-await-in-loop -- same ordering: the parent has to land before its child
        await adapter.mkdir(acc).catch(async (err) => {
          // Tolerate races where another operation created it first.
          if (!(await adapter.exists(acc))) throw asError(err);
        });
      }
    }
  }
}
