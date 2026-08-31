/**
 * VaultAdapter — the boundary between Obsidian and the rest of the plugin.
 *
 * Everything below the UI layer talks to the vault exclusively through this
 * interface, so the indexing/retrieval/memory services can be unit-tested with
 * an in-memory implementation and never import `obsidian` directly.
 *
 * All `path` arguments are vault-relative, forward-slash paths that have
 * already been validated by `utils/paths`. Adapters themselves do NOT perform
 * traversal validation — callers must sanitize first. Adapters DO refuse to
 * operate on absolute paths as a defense-in-depth backstop.
 */

import { isAbsoluteLike } from "../utils/paths";
import { PathSecurityError } from "../utils/errors";

export interface VaultFile {
  /** Vault-relative path, forward slashes. */
  path: string;
  /** Last-modified time, ms since epoch. */
  mtime: number;
  /** Size in bytes (best effort; 0 if unknown). */
  size: number;
}

export interface VaultAdapter {
  /** Human-readable vault name (for display/logging only). */
  vaultName(): string;

  /** Read a UTF-8 text file. Rejects if it does not exist. */
  read(path: string): Promise<string>;

  /** True if a file OR folder exists at the path. */
  exists(path: string): Promise<boolean>;

  /**
   * Write a text file, creating parent folders as needed. Implementations
   * should write as atomically as the platform allows (temp + rename).
   */
  write(path: string, content: string): Promise<void>;

  /** Append text to a file, creating it (and parents) if missing. */
  append(path: string, content: string): Promise<void>;

  /** Recursively ensure a folder exists. */
  ensureFolder(path: string): Promise<void>;

  /** List all Markdown files in the vault with their mtimes. */
  listMarkdownFiles(): Promise<VaultFile[]>;

  /**
   * List vault files whose (lowercased) extension is in `extensions`
   * (e.g. [".pdf"]). Used by attachment indexing.
   */
  listFilesByExtension(extensions: string[]): Promise<VaultFile[]>;

  /** Read a file's raw bytes. Rejects if it does not exist. */
  readBinary(path: string): Promise<ArrayBuffer>;

  /** Mtime (ms epoch) of a single file, or null if it does not exist. */
  getMtime(path: string): Promise<number | null>;
}

/** Backstop used by every adapter method to reject absolute paths. */
export function assertRelative(path: string): void {
  if (typeof path !== "string" || isAbsoluteLike(path)) {
    throw new PathSecurityError(`Adapter received a non-relative path: "${path}"`);
  }
}

/**
 * In-memory VaultAdapter for tests. Models a flat map of path → {content, mtime}.
 * Folder existence is inferred from file paths plus explicitly-created folders.
 */
export class InMemoryVaultAdapter implements VaultAdapter {
  private files = new Map<string, { content: string; mtime: number }>();
  private folders = new Set<string>();
  private clock: number;

  constructor(
    private readonly name = "test-vault",
    seedFiles: Record<string, string> = {},
    startClock = 1_000,
  ) {
    this.clock = startClock;
    for (const [path, content] of Object.entries(seedFiles)) {
      this.files.set(path, { content, mtime: this.tick() });
      this.registerFolders(path);
    }
  }

  private tick(): number {
    return this.clock++;
  }

  /**
   * Test support: set a file's mtime directly.
   *
   * Writes tick the clock by one, so files written through the adapter land
   * milliseconds apart and no realistic time WINDOW can separate them. Tests
   * that exercise recency need files genuinely days apart, and the alternative
   * — threading a settable clock through every write — buys nothing else.
   */
  setMtime(path: string, mtime: number): void {
    const file = this.files.get(path);
    if (!file) throw new Error(`setMtime: no such file: ${path}`);
    file.mtime = mtime;
  }

  private registerFolders(path: string): void {
    const parts = path.split("/");
    parts.pop();
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      this.folders.add(acc);
    }
  }

  vaultName(): string {
    return this.name;
  }

  async read(path: string): Promise<string> {
    assertRelative(path);
    const entry = this.files.get(path);
    if (!entry) throw new Error(`File not found: ${path}`);
    return entry.content;
  }

  async exists(path: string): Promise<boolean> {
    assertRelative(path);
    return this.files.has(path) || this.folders.has(path);
  }

  async write(path: string, content: string): Promise<void> {
    assertRelative(path);
    this.files.set(path, { content, mtime: this.tick() });
    this.registerFolders(path);
  }

  async append(path: string, content: string): Promise<void> {
    assertRelative(path);
    const existing = this.files.get(path);
    const next = (existing ? existing.content : "") + content;
    this.files.set(path, { content: next, mtime: this.tick() });
    this.registerFolders(path);
  }

  async ensureFolder(path: string): Promise<void> {
    assertRelative(path);
    this.registerFolders(`${path}/.placeholder`);
    this.folders.add(path);
  }

  async listMarkdownFiles(): Promise<VaultFile[]> {
    const out: VaultFile[] = [];
    for (const [path, { content, mtime }] of this.files) {
      if (path.toLowerCase().endsWith(".md")) {
        out.push({ path, mtime, size: content.length });
      }
    }
    return out;
  }

  async listFilesByExtension(extensions: string[]): Promise<VaultFile[]> {
    const exts = extensions.map((e) => e.toLowerCase());
    const out: VaultFile[] = [];
    for (const [path, { content, mtime }] of this.files) {
      if (exts.some((e) => path.toLowerCase().endsWith(e))) {
        out.push({ path, mtime, size: content.length });
      }
    }
    for (const [path, { bytes, mtime }] of this.binaryFiles) {
      if (exts.some((e) => path.toLowerCase().endsWith(e))) {
        out.push({ path, mtime, size: bytes.byteLength });
      }
    }
    return out;
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    assertRelative(path);
    const bin = this.binaryFiles.get(path);
    if (bin) {
      // Copy into a plain ArrayBuffer (a Uint8Array may view a SharedArrayBuffer).
      const copy = new Uint8Array(bin.bytes.byteLength);
      copy.set(bin.bytes);
      return copy.buffer;
    }
    const text = this.files.get(path);
    if (text) return new TextEncoder().encode(text.content).buffer;
    throw new Error(`readBinary: no such file: ${path}`);
  }

  async getMtime(path: string): Promise<number | null> {
    assertRelative(path);
    return this.files.get(path)?.mtime ?? this.binaryFiles.get(path)?.mtime ?? null;
  }

  // --- test helpers ---

  private binaryFiles = new Map<string, { bytes: Uint8Array; mtime: number }>();

  /** Seed a binary attachment (test helper). */
  seedBinary(path: string, bytes: Uint8Array): void {
    this.binaryFiles.set(path, { bytes, mtime: this.tick() });
    this.registerFolders(path);
  }

  /** Touch a file's content and bump its mtime (simulates an external edit). */
  touch(path: string, content: string): void {
    this.files.set(path, { content, mtime: this.tick() });
    this.registerFolders(path);
  }

  /** Remove a file (simulates the user deleting a note). Test helper only —
   * the production VaultAdapter interface deliberately has no delete. */
  removeFile(path: string): void {
    this.files.delete(path);
    this.binaryFiles.delete(path);
  }

  /** Raw snapshot for assertions. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, { content }] of this.files) out[path] = content;
    return out;
  }
}
