/**
 * extraction-cache — mtime-keyed cache of extracted attachment text, persisted
 * as JSON under `Index/` (a rebuildable artifact, like chunks.json). Without
 * it every plugin reload would re-parse every attachment; with it a reload
 * costs one JSON read. Negative results (`text: null` — image-only or corrupt
 * files) are cached too, so a broken PDF isn't re-parsed on every refresh.
 */

import { VaultAdapter } from "../core/vault-adapter";
import { Logger, NULL_LOGGER } from "../utils/logger";

// Bump when the cache-file format OR any extractor's output logic changes: the
// cache is keyed on path+mtime, so a fixed extractor would otherwise keep
// returning a stale (possibly negatively-cached) result for an unchanged file.
const CACHE_VERSION = 2;

interface CacheEntry {
  mtime: number;
  text: string | null;
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

export class ExtractionCache {
  private state: Record<string, CacheEntry> | null = null;
  private dirty = false;

  constructor(
    private readonly adapter: VaultAdapter,
    private readonly file: string,
    private readonly logger: Logger = NULL_LOGGER,
  ) {}

  /** Load the persisted cache once; tolerant of a missing/corrupt file. */
  async load(): Promise<void> {
    if (this.state !== null) return;
    this.state = {};
    try {
      if (!(await this.adapter.exists(this.file))) return;
      const parsed = JSON.parse(await this.adapter.read(this.file)) as CacheFile;
      if (parsed && parsed.version === CACHE_VERSION && parsed.entries) {
        this.state = parsed.entries;
      }
    } catch (err) {
      this.logger.warn("Extraction cache unreadable; starting fresh", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Cached text for path@mtime; undefined = not cached (extract it). */
  get(path: string, mtime: number): CacheEntry | undefined {
    const e = this.state?.[path];
    return e && e.mtime === mtime ? e : undefined;
  }

  set(path: string, mtime: number, text: string | null): void {
    if (this.state === null) this.state = {};
    this.state[path] = { mtime, text };
    this.dirty = true;
  }

  /** Drop entries for attachments that no longer exist / are no longer eligible. */
  prune(livePaths: Set<string>): void {
    if (this.state === null) return;
    for (const path of Object.keys(this.state)) {
      if (!livePaths.has(path)) {
        delete this.state[path];
        this.dirty = true;
      }
    }
  }

  /** Persist only when something changed (same no-op discipline as the index). */
  async persist(): Promise<void> {
    if (!this.dirty || this.state === null) return;
    await this.adapter.write(this.file, JSON.stringify({ version: CACHE_VERSION, entries: this.state }));
    this.dirty = false;
  }
}
