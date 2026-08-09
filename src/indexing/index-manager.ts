/**
 * index-manager — build, refresh, persist and load the local JSON index.
 *
 * The index is a rebuildable cache: Markdown remains the source of truth. We
 * store chunk records (with path/heading/line-span/tags) in `chunks.json` and
 * summary info in `metadata.json`. `embeddings.json` is written as an empty
 * shell in M1 and populated once a vector provider is enabled (M3).
 *
 * Refresh is incremental: notes whose mtime is unchanged keep their existing
 * chunks; only new/modified notes are re-chunked and deleted notes are dropped.
 */

import { VaultAdapter } from "../core/vault-adapter";
import { toMessage } from "../utils/errors";
import { chunkMarkdown, ChunkOptions } from "../core/markdown-chunker";
import { ScannedNote, ScanResult, isUnchangedNote } from "./vault-scanner";
import { Logger, NULL_LOGGER } from "../utils/logger";

// Bump whenever chunk BOUNDARIES change, not just the file format: a stale
// index is otherwise kept and silently scored against the old chunking. Raised
// to 2 when the section budget went 1200 -> 2400 and oversized paragraphs began
// splitting — both change what a chunk is, so existing indexes must rebuild.
export const INDEX_VERSION = 2;

export interface IndexedChunk {
  id: string;
  notePath: string;
  heading: string;
  headingPath: string[];
  text: string;
  startLine: number;
  endLine: number;
  tags: string[];
  aliases: string[];
  links: string[];
  mtime: number;
}

export interface IndexMetadata {
  version: number;
  builtAt: number;
  noteCount: number;
  chunkCount: number;
  /**
   * mtime per indexed note, so a reload restores the skip-unchanged fast path
   * exactly. Optional on purpose: an index written before this existed simply
   * falls back to chunk-derived mtimes, and writes this field on its next
   * persist — no version bump, so nobody is forced into a full reindex.
   */
  noteMtimes?: Record<string, number>;
  /**
   * The scan config `noteMtimes` was gathered under, so a reload can tell
   * whether those verdicts still apply instead of assuming they don't.
   */
  scanConfigKey?: string;
}

export interface VaultIndex {
  metadata: IndexMetadata;
  chunks: IndexedChunk[];
}

export interface IndexPaths {
  chunksFile: string;
  metadataFile: string;
  embeddingsFile: string;
}

export interface RefreshResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
}

export interface IndexManagerOptions {
  chunkOptions?: ChunkOptions;
  logger?: Logger;
  clock?: () => number;
}

export function chunkNote(note: ScannedNote, chunkOptions?: ChunkOptions): IndexedChunk[] {
  const chunks = chunkMarkdown(note.content, {
    ...chunkOptions,
    bodyStartLine: note.metadata.bodyStartLine,
  });
  // A frontmatter-only note (alias/link-hub notes: aliases or tags, no body)
  // yields zero chunks and is invisible to retrieval — its aliases and
  // filename can never field-match. Give it one stub chunk naming the note,
  // spanning the frontmatter lines. Truly empty notes stay unindexed.
  if (
    chunks.length === 0 &&
    (note.metadata.aliases.length > 0 || note.metadata.tags.length > 0)
  ) {
    const basename = note.path.slice(note.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    const aliasLine =
      note.metadata.aliases.length > 0 ? `\nAliases: ${note.metadata.aliases.join(", ")}` : "";
    chunks.push({
      heading: "",
      headingPath: [],
      text: `${basename}${aliasLine}`,
      startLine: 0,
      endLine: Math.max(0, note.metadata.bodyStartLine - 1),
    });
  }
  return chunks.map((c, ordinal) => ({
    id: `${note.path}::${ordinal}`,
    notePath: note.path,
    heading: c.heading,
    headingPath: c.headingPath,
    text: c.text,
    startLine: c.startLine,
    endLine: c.endLine,
    tags: note.metadata.tags,
    aliases: note.metadata.aliases,
    links: note.metadata.links,
    mtime: note.mtime,
  }));
}

export class IndexManager {
  private index: VaultIndex | null = null;
  /**
   * mtime of every note seen by the last build/refresh — INCLUDING zero-chunk
   * notes (empty files), which leave no trace in `chunks` and would otherwise
   * read as "added" on every refresh. Persisted with the index and restored by
   * load(); only an index written before that existed falls back to chunks.
   */
  private noteMtimes: Map<string, number> | null = null;
  /**
   * The scan config those mtimes were gathered under. The map's verdicts are
   * only trustworthy while the config is unchanged — an exclusion added since
   * would make an "unchanged" stub stand in for a note that should now be gone.
   */
  private scanConfigKey: string | null = null;
  /**
   * The metadata on disk is missing or stale relative to what we now know —
   * true after a load that found no (or an unusable) mtime map or scan key.
   * Without this, an index whose CONTENT is unchanged never persists, so the
   * newly-learned metadata is never written and the fast path it enables never
   * engages: the very next launch re-reads the whole vault again, forever.
   */
  private metadataStale = false;
  private readonly chunkOptions?: ChunkOptions;
  private readonly logger: Logger;
  private readonly clock: () => number;

  constructor(
    private readonly adapter: VaultAdapter,
    private readonly paths: IndexPaths,
    options: IndexManagerOptions = {},
  ) {
    this.chunkOptions = options.chunkOptions;
    this.logger = options.logger ?? NULL_LOGGER;
    this.clock = options.clock ?? (() => Date.now());
  }

  getIndex(): VaultIndex | null {
    return this.index;
  }

  getChunks(): IndexedChunk[] {
    return this.index?.chunks ?? [];
  }

  /** The scan config the current mtimes were gathered under, if it is known. */
  getScanConfigKey(): string | null {
    return this.scanConfigKey;
  }

  /** Record the scan config the caller just scanned under. */
  setScanConfigKey(key: string): void {
    if (key !== this.scanConfigKey) {
      this.scanConfigKey = key;
      this.metadataStale = true;
    }
  }

  /**
   * True when persisting would write metadata the file does not already hold.
   * The caller skips a no-op persist to avoid re-serializing a large index, so
   * it needs this to know when the metadata alone is worth writing.
   */
  needsMetadataPersist(): boolean {
    return this.metadataStale;
  }

  /**
   * mtimes of the notes in the current index, for the scanner's skip-unchanged
   * fast path. Restored by load() from the persisted map; the chunk-derived
   * fallback is only for an index written before that map existed (zero-chunk
   * notes are absent there, so they are re-read once and settle — same contract
   * as refresh()).
   */
  getNoteMtimes(): Map<string, number> {
    if (this.noteMtimes) return this.noteMtimes;
    const map = new Map<string, number>();
    for (const chunk of this.getChunks()) {
      if (!map.has(chunk.notePath)) map.set(chunk.notePath, chunk.mtime);
    }
    return map;
  }

  /** Full rebuild from the given notes, replacing any in-memory index. */
  build(notes: ScannedNote[]): VaultIndex {
    const chunks: IndexedChunk[] = [];
    for (const note of notes) {
      chunks.push(...chunkNote(note, this.chunkOptions));
    }
    this.noteMtimes = new Map(notes.map((n) => [n.path, n.mtime]));
    this.index = {
      metadata: {
        version: INDEX_VERSION,
        builtAt: this.clock(),
        noteCount: notes.length,
        chunkCount: chunks.length,
      },
      chunks,
    };
    return this.index;
  }

  /**
   * Incremental refresh. Notes with an unchanged mtime keep their chunks;
   * changed/new notes are re-chunked; notes absent from `notes` are removed.
   * Paths in `force` are re-chunked even when their mtime is unchanged — used
   * when extracted attachment text may have changed under a stable mtime
   * (extraction-cache version bump). Content-less stubs can't be forced.
   */
  refresh(notes: ScanResult[], force?: Set<string>): RefreshResult {
    const existing = this.index?.chunks ?? [];
    const existingByNote = new Map<string, IndexedChunk[]>();
    for (const chunk of existing) {
      const list = existingByNote.get(chunk.notePath) ?? [];
      list.push(chunk);
      existingByNote.set(chunk.notePath, list);
    }

    const result: RefreshResult = { added: 0, updated: 0, removed: 0, unchanged: 0 };
    const nextChunks: IndexedChunk[] = [];
    const seenNotes = new Set<string>();

    // Note identity comes from the mtime map, not from chunks: a zero-chunk
    // note (empty file) leaves no chunks, and deriving identity from chunks
    // made such a note read as "added" on every refresh — which kept the
    // all-unchanged fast path below from ever engaging. Fall back to
    // chunk-derived mtimes for an index loaded from disk (a zero-chunk note
    // then reads as added once, and settles).
    const priorMtimes =
      this.noteMtimes ??
      new Map(Array.from(existingByNote, ([path, chunks]) => [path, chunks[0].mtime]));

    for (const note of notes) {
      seenNotes.add(note.path);
      const priorMtime = priorMtimes.get(note.path);
      const forced = force !== undefined && force.has(note.path) && !isUnchangedNote(note);
      if (!forced && (priorMtime === note.mtime || isUnchangedNote(note))) {
        // A content-less stub with a mismatched mtime is impossible when the
        // caller passes THIS manager's getNoteMtimes() to the scanner, but if
        // one ever arrives, keeping the prior chunks is the only safe option —
        // there is no content to re-chunk.
        nextChunks.push(...(existingByNote.get(note.path) ?? []));
        if (priorMtime === note.mtime) result.unchanged++;
        else result.updated++;
      } else {
        nextChunks.push(...chunkNote(note, this.chunkOptions));
        if (priorMtime !== undefined) result.updated++;
        else result.added++;
      }
    }

    for (const notePath of priorMtimes.keys()) {
      if (!seenNotes.has(notePath)) result.removed++;
    }
    this.noteMtimes = new Map(notes.map((n) => [n.path, n.mtime]));

    // On an all-unchanged refresh, keep the PREVIOUS chunks array (same
    // elements, possibly different scan order): retrieval memoizes corpus
    // stats by chunks-array identity, so swapping in an equal-content array
    // would silently re-pay the full stats build on the next query.
    const noop =
      result.added === 0 && result.updated === 0 && result.removed === 0 && this.index !== null;
    this.index = {
      metadata: {
        version: INDEX_VERSION,
        builtAt: this.clock(),
        noteCount: notes.length,
        chunkCount: nextChunks.length,
      },
      chunks: noop ? existing : nextChunks,
    };
    return result;
  }

  /** Persist the current index to disk as JSON (atomic via the adapter). */
  async persist(): Promise<void> {
    if (!this.index) return;
    await this.adapter.write(this.paths.chunksFile, JSON.stringify(this.index.chunks));
    // Carry the mtime map so the next load starts from it rather than deriving
    // mtimes from chunks — a note that produced no chunks leaves no trace there.
    const metadata: IndexMetadata = this.noteMtimes
      ? {
          ...this.index.metadata,
          noteMtimes: Object.fromEntries(this.noteMtimes),
          ...(this.scanConfigKey === null ? {} : { scanConfigKey: this.scanConfigKey }),
        }
      : this.index.metadata;
    await this.adapter.write(this.paths.metadataFile, JSON.stringify(metadata, null, 2));
    this.metadataStale = false;
    // Placeholder embeddings shell; populated when a vector provider is enabled.
    if (!(await this.adapter.exists(this.paths.embeddingsFile))) {
      await this.adapter.write(
        this.paths.embeddingsFile,
        JSON.stringify({ model: null, dim: 0, vectors: {} }, null, 2),
      );
    }
  }

  /**
   * Load a previously-persisted index. Returns the index on success, or null if
   * missing / unparseable / version-mismatched (caller should rebuild).
   */
  async load(): Promise<VaultIndex | null> {
    try {
      if (!(await this.adapter.exists(this.paths.chunksFile))) return null;
      if (!(await this.adapter.exists(this.paths.metadataFile))) return null;
      const metaRaw = await this.adapter.read(this.paths.metadataFile);
      const chunksRaw = await this.adapter.read(this.paths.chunksFile);
      const metadata = JSON.parse(metaRaw) as IndexMetadata;
      const chunks = JSON.parse(chunksRaw) as IndexedChunk[];
      if (metadata.version !== INDEX_VERSION || !Array.isArray(chunks)) {
        this.logger.warn("Index version mismatch or corrupt; rebuild required");
        return null;
      }
      this.index = { metadata, chunks };
      // Restore the mtime map when the index carries one. Without it, a note
      // that chunks to nothing (empty, or whitespace only) is invisible in the
      // chunk-derived fallback and reads as newly added on the first refresh of
      // every session — which persists the whole index, tens of MB at scale, on
      // the app's main thread, at every startup.
      // Both fields are optional and come off disk, so a file written by an
      // older version — or corrupted by a sync conflict — must degrade to the
      // slow-but-correct path rather than be trusted for its type.
      const storedMtimes =
        metadata.noteMtimes && typeof metadata.noteMtimes === "object"
          ? Object.entries(metadata.noteMtimes).filter(([, v]) => typeof v === "number")
          : null;
      this.noteMtimes = storedMtimes ? new Map(storedMtimes) : null;
      this.scanConfigKey =
        typeof metadata.scanConfigKey === "string" ? metadata.scanConfigKey : null;
      // Anything we could not restore has to be written back, and an unchanged
      // vault never persists on its own.
      this.metadataStale = this.noteMtimes === null || this.scanConfigKey === null;
      return this.index;
    } catch (err) {
      this.logger.warn("Failed to load index; rebuild required", {
        error: toMessage(err),
      });
      return null;
    }
  }
}
