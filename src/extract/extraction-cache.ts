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

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * The persisted entries, checked to be what the refresh pass assumes.
 *
 * `get` already ignores an entry whose `mtime` does not match the file on disk,
 * which absorbs most damage — a `null` or a number simply misses and the
 * attachment is re-extracted. Two things get past it, and both matter:
 *
 * An entry whose `mtime` does match but whose `text` is not a string reaches
 * `remainingChars -= entry.text.length`, which is `NaN`. Every later
 * `remainingChars <= 0` is then false, so the corpus-wide attachment budget
 * stops being enforced for the rest of the scan — the budget that exists to
 * keep a large vault from building an index string V8 refuses to serialize.
 *
 * `metadata` is cached alongside the text and feeds `isMetadataEligible`, so
 * malformed `tags` could let an attachment the user excluded by tag be indexed
 * anyway. Exclusions are a privacy control; they must not depend on the shape
 * of a cache file.
 */
function areCacheEntries(value: unknown): value is Record<string, CacheEntry> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  for (const entry of Object.values(value)) {
    if (typeof entry !== "object" || entry === null) return false;
    const cached = entry as Record<string, unknown>;
    if (typeof cached.mtime !== "number") return false;
    if (cached.text !== null && typeof cached.text !== "string") return false;
    if (cached.metadata !== undefined && !isNoteMetadata(cached.metadata)) return false;
  }
  return true;
}

function isNoteMetadata(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const metadata = value as Record<string, unknown>;
  return (
    isStringArray(metadata.tags) &&
    isStringArray(metadata.aliases) &&
    isStringArray(metadata.links) &&
    typeof metadata.bodyStartLine === "number" &&
    (metadata.title === undefined || typeof metadata.title === "string")
  );
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
      if (parsed && parsed.version === CACHE_VERSION && areCacheEntries(parsed.entries)) {
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
