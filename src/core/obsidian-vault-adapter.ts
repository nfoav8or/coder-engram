/**
 * ObsidianVaultAdapter — the production VaultAdapter, backed by Obsidian's
 * Vault API. This is the ONLY service-layer file permitted to import
 * `obsidian`. All paths are assumed pre-validated by callers; this adapter
 * additionally refuses absolute paths and uses temp+rename for safer writes.
 */

import { App, normalizePath } from "obsidian";
import { VaultAdapter, VaultFile, assertRelative } from "./vault-adapter";
import { toMessage } from "../utils/errors";

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
      throw err;
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
      throw err;
    }
    // The write is durable; the backup is now just garbage.
    if (backup) await adapter.remove(backup).catch(() => undefined);
  }

  async append(path: string, content: string): Promise<void> {
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
          if (!(await adapter.exists(acc))) throw err;
        });
      }
    }
  }
}
