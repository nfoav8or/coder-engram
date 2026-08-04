/**
 * extraction-cache — mtime-keyed cache of extracted attachment text, persisted
 * as JSON under `Index/` (a rebuildable artifact, like chunks.json). Without
 * it every plugin reload would re-parse every attachment; with it a reload
 * costs one JSON read. Negative results (`text: null` — image-only or corrupt
 * files) are cached too, so a broken PDF isn't re-parsed on every refresh.
 */

import { NoteMetadata } from "../core/metadata-extractor";
import { VaultAdapter } from "../core/vault-adapter";
import { toMessage } from "../utils/errors";
import { Logger, NULL_LOGGER } from "../utils/logger";

// Bump when the cache-file format, any extractor's output logic, OR the
// metadata extractor's output changes: the cache is keyed on path+mtime, so a
// fixed extractor would otherwise keep returning a stale (possibly
// negatively-cached) result for an unchanged file — and `metadata` below is
// derived from the text, so it goes stale the same way.
const CACHE_VERSION = 2;

interface CacheEntry {
  mtime: number;
  text: string | null;
  /**
   * Tags/links/title derived from `text`. Optional so a cache file written
   * before this field self-upgrades on the next scan instead of forcing every
   * attachment to be re-extracted.
   */
  metadata?: NoteMetadata;
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

export class ExtractionCache {
  private state: Record<string, CacheEntry> | null = null;
  private dirty = false;
  private reset = false;

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
      } else {
        this.reset = true;
      }
    } catch (err) {
      this.reset = true;
      this.logger.warn("Extraction cache unreadable; starting fresh", {
        error: toMessage(err),
      });
    }
  }

  /**
   * True (once) when load() discarded a persisted cache — version bump or
   * corrupt file. Re-extraction may then yield different text for files whose
   * mtime is unchanged, so the caller must re-chunk attachments instead of
   * trusting the index's mtime short-circuit; without this, an extractor fix
   * shipped via a CACHE_VERSION bump never reaches already-indexed chunks.
   */
  consumeReset(): boolean {
    const was = this.reset;
    this.reset = false;
    return was;
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

  /**
   * Store metadata derived from an entry's text. Kept separate from `set`
   * because the caller derives it after extraction, and because an entry
   * restored from an older cache file needs it filled in without re-extracting.
   */
  rememberMetadata(path: string, metadata: NoteMetadata): void {
    const entry = this.state?.[path];
    if (!entry || entry.metadata !== undefined) return;
    entry.metadata = metadata;
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
