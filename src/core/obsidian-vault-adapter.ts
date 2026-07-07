/**
 * ObsidianVaultAdapter — the production VaultAdapter, backed by Obsidian's
 * Vault API. This is the ONLY service-layer file permitted to import
 * `obsidian`. All paths are assumed pre-validated by callers; this adapter
 * additionally refuses absolute paths and uses temp+rename for safer writes.
 */

import { App, normalizePath } from "obsidian";
import { VaultAdapter, VaultFile, assertRelative } from "./vault-adapter";

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
    const tmp = `${target}.engram-tmp-${Date.now()}-${tempCounter++}`;
    const adapter = this.app.vault.adapter;
    await adapter.write(tmp, content);
    try {
      if (await adapter.exists(target)) {
        await adapter.remove(target);
      }
      await adapter.rename(tmp, target);
    } catch (err) {
      // Best-effort cleanup of the temp file on failure.
      if (await adapter.exists(tmp)) {
        await adapter.remove(tmp).catch(() => undefined);
      }
      throw err;
    }
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
      // eslint-disable-next-line no-await-in-loop
      if (!(await adapter.exists(acc))) {
        // eslint-disable-next-line no-await-in-loop
        await adapter.mkdir(acc).catch(async (err) => {
          // Tolerate races where another operation created it first.
          if (!(await adapter.exists(acc))) throw err;
        });
      }
    }
  }
}
