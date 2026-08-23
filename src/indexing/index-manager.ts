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
import { fnv1a32 } from "../utils/hash";
import { chunkMarkdown, ChunkOptions } from "../core/markdown-chunker";
import { ScannedNote, ScanResult, isUnchangedNote } from "./vault-scanner";
import { Logger, NULL_LOGGER } from "../utils/logger";

// Bump whenever chunk BOUNDARIES change, not just the file format: a stale
// index is otherwise kept and silently scored against the old chunking. Raised
// to 2 when the section budget went 1200 -> 2400 and oversized paragraphs began
// splitting — both change what a chunk is, so existing indexes must rebuild.
//
// Raised to 3 for a different reason: inline #tags were harvested with an
// ASCII-only pattern, so an exclusion naming an accented or non-Latin tag
// matched nothing and the note was indexed anyway. Fixing the parser only
// changes what happens on the next READ of a note, and a refresh re-reads a
// note only when its mtime changed — so without this bump, notes the user
// excluded would sit in the index indefinitely, still reachable over the local
// server. One forced rebuild drops them.
export const INDEX_VERSION = 3;

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

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Every field the retrieval path dereferences, checked against the type that
 * path assumes.
 *
 * `load` already refuses a file that is not JSON, is not an array, or was
 * written under a different `INDEX_VERSION`, and it already validates the two
 * optional metadata maps entry by entry rather than trusting them for their
 * type. The chunks themselves were the gap: any array loaded clean, so an index
 * holding `[null]` or objects missing `text` reported success and then threw a
 * TypeError out of the retriever on every later query — a plugin that says it
 * has an index and fails every search until someone reindexes by hand. Every
 * field has been written since the first release, so requiring all of them
 * cannot invalidate an index that real code produced.
 */
function isIndexedChunk(value: unknown): value is IndexedChunk {
  if (typeof value !== "object" || value === null) return false;
  const chunk = value as Record<string, unknown>;
  return (
    typeof chunk.id === "string" &&
    typeof chunk.notePath === "string" &&
    typeof chunk.heading === "string" &&
    typeof chunk.text === "string" &&
    typeof chunk.startLine === "number" &&
    typeof chunk.endLine === "number" &&
    typeof chunk.mtime === "number" &&
    isStringArray(chunk.headingPath) &&
    isStringArray(chunk.tags) &&
    isStringArray(chunk.aliases) &&
    isStringArray(chunk.links)
  );
}

export interface IndexMetadata {
  version: number;
  builtAt: number;
  noteCount: number;
  chunkCount: number;
  /**
   * How the chunks are persisted. Absent (older files) means "single". The
   * field is written so a reload never has to guess which files to read —
   * the layout decision is recorded, not re-derived.
   */
  layout?: "single" | "sharded";
  /** Shard count when `layout` is "sharded". Only 256 is ever written; a file
   * claiming anything else is treated as corrupt (rebuild) rather than guessed at. */
  shardCount?: number;
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
  /**
   * Chunk count above which persistence switches to the sharded layout.
   * Exists so tests can exercise sharding without 20k-chunk fixtures; real
   * callers take the default.
   */
  singleFileMaxChunks?: number;
}

/**
 * Sharded-layout constants. Above SINGLE_FILE_MAX_CHUNKS the index persists as
 * 256 shard files (`chunks-00.json` … `chunks-ff.json`, routed by FNV-1a of
 * the note path) so an edit rewrites ~1/256 of the corpus instead of one
 * monolithic chunks.json — the write cost that dominates large vaults and
 * hammers sync clients. Below SHARD_DOWN_FACTOR × threshold it switches back;
 * the gap is hysteresis so a vault sitting at the boundary doesn't rewrite its
 * whole cache on alternate refreshes. Small vaults never leave the single-file
 * layout and see byte-identical behavior to previous releases.
 */
const SINGLE_FILE_MAX_CHUNKS = 20_000;
const SHARD_DOWN_FACTOR = 0.8;
const SHARD_COUNT = 256;
/** Yield to the host event loop after this many notes are re-chunked in one
 * refresh, so a large rebuild cannot freeze the renderer. */
const CHUNK_YIELD_EVERY = 500;

function shardOf(notePath: string): number {
  return fnv1a32(notePath) % SHARD_COUNT;
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
  /**
   * Persisted layout of the CURRENT on-disk files ("single" until a sharded
   * persist happens). Kept as state, not re-derived, so persist can tell a
   * layout switch (rewrite everything, blank the obsolete files) from a
   * steady-state write (dirty shards only).
   */
  private layout: "single" | "sharded" = "single";
  /** Shards touched since the last persist. Meaningful only for the sharded
   * layout; a layout switch or full build sets allShardsDirty instead. */
  private dirtyShards = new Set<number>();
  private allShardsDirty = true;
  private readonly chunkOptions?: ChunkOptions;
  private readonly singleFileMaxChunks: number;
  private readonly logger: Logger;
  private readonly clock: () => number;

  constructor(
    private readonly adapter: VaultAdapter,
    private readonly paths: IndexPaths,
    options: IndexManagerOptions = {},
  ) {
    this.chunkOptions = options.chunkOptions;
    this.singleFileMaxChunks = options.singleFileMaxChunks ?? SINGLE_FILE_MAX_CHUNKS;
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
  async build(notes: ScannedNote[]): Promise<VaultIndex> {
    const chunks: IndexedChunk[] = [];
    let chunkedSinceYield = 0;
    for (const note of notes) {
      chunks.push(...chunkNote(note, this.chunkOptions));
      // A full rebuild chunks the whole vault in one call; yield between
      // slices so the host's UI thread stays alive (see refresh).
      if (++chunkedSinceYield >= CHUNK_YIELD_EVERY) {
        chunkedSinceYield = 0;
        // eslint-disable-next-line no-await-in-loop -- deliberate cooperative yield
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    this.noteMtimes = new Map(notes.map((n) => [n.path, n.mtime]));
    this.allShardsDirty = true;
    this.dirtyShards.clear();
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
  async refresh(notes: ScanResult[], force?: Set<string>): Promise<RefreshResult> {
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
    let chunkedSinceYield = 0;

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
        this.dirtyShards.add(shardOf(note.path));
        // A large rebuild re-chunks thousands of notes in one call; yielding
        // between slices keeps the host's UI thread alive. Unchanged notes are
        // free and don't count toward the slice.
        if (++chunkedSinceYield >= CHUNK_YIELD_EVERY) {
          chunkedSinceYield = 0;
          // eslint-disable-next-line no-await-in-loop -- deliberate cooperative yield
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }

    for (const notePath of priorMtimes.keys()) {
      if (!seenNotes.has(notePath)) {
        result.removed++;
        this.dirtyShards.add(shardOf(notePath));
      }
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

  /** Path of shard `i` (derived from the validated chunks path, so shards can
   * only ever live beside chunks.json inside `Index/`). */
  private shardFile(i: number): string {
    const hex = i.toString(16).padStart(2, "0");
    return this.paths.chunksFile.replace(/\.json$/, `-${hex}.json`);
  }

  /**
   * Layout for the NEXT persist. Sticky around the threshold (hysteresis) so a
   * vault at the boundary doesn't rewrite its whole cache on alternate saves.
   */
  private nextLayout(chunkCount: number): "single" | "sharded" {
    if (this.layout === "sharded") {
      return chunkCount < this.singleFileMaxChunks * SHARD_DOWN_FACTOR ? "single" : "sharded";
    }
    return chunkCount > this.singleFileMaxChunks ? "sharded" : "single";
  }

  /** Persist the current index to disk as JSON (atomic via the adapter). */
  async persist(): Promise<void> {
    if (!this.index) return;
    const chunks = this.index.chunks;
    const layout = this.nextLayout(chunks.length);
    const switching = layout !== this.layout;
    if (switching) {
      this.logger.info("Index layout switch", { from: this.layout, to: layout, chunks: chunks.length });
    }

    if (layout === "single") {
      await this.adapter.write(this.paths.chunksFile, JSON.stringify(chunks));
      if (switching) {
        // The adapter deliberately has no delete (nothing in this plugin ever
        // destroys files); obsolete shards are blanked to a tiny sentinel the
        // loader never reads (layout says "single").
        for (let i = 0; i < SHARD_COUNT; i++) {
          // eslint-disable-next-line no-await-in-loop -- rare one-time layout downgrade
          await this.adapter.write(this.shardFile(i), "[]");
        }
      }
    } else {
      const groups: IndexedChunk[][] = Array.from({ length: SHARD_COUNT }, () => []);
      for (const chunk of chunks) groups[shardOf(chunk.notePath)].push(chunk);
      const writeAll = switching || this.allShardsDirty;
      let written = 0;
      for (let i = 0; i < SHARD_COUNT; i++) {
        if (!writeAll && !this.dirtyShards.has(i)) continue;
        // eslint-disable-next-line no-await-in-loop -- shard writes are sequential on purpose: parallel writes through the adapter would interleave vault I/O with no gain
        await this.adapter.write(this.shardFile(i), JSON.stringify(groups[i]));
        written++;
      }
      this.logger.info("Persisted index shards", { written, of: SHARD_COUNT });
      if (switching) {
        // Blank the obsolete monolith (see the no-delete note above).
        await this.adapter.write(this.paths.chunksFile, "[]");
      }
    }

    // Carry the mtime map so the next load starts from it rather than deriving
    // mtimes from chunks — a note that produced no chunks leaves no trace there.
    const metadata: IndexMetadata = {
      ...this.index.metadata,
      ...(this.noteMtimes
        ? {
            noteMtimes: Object.fromEntries(this.noteMtimes),
            ...(this.scanConfigKey === null ? {} : { scanConfigKey: this.scanConfigKey }),
          }
        : {}),
      // Record the layout when sharded; a single-file metadata stays
      // byte-compatible with what older releases wrote and read.
      ...(layout === "sharded" ? { layout, shardCount: SHARD_COUNT } : {}),
    };
    await this.adapter.write(this.paths.metadataFile, JSON.stringify(metadata, null, 2));
    this.layout = layout;
    this.dirtyShards.clear();
    this.allShardsDirty = false;
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
      if (!(await this.adapter.exists(this.paths.metadataFile))) return null;
      const metaRaw = await this.adapter.read(this.paths.metadataFile);
      const metadata = JSON.parse(metaRaw) as IndexMetadata;
      if (metadata.version !== INDEX_VERSION) {
        this.logger.warn("Index version mismatch; rebuild required");
        return null;
      }

      let chunks: IndexedChunk[];
      if (metadata.layout === "sharded") {
        // Only the one shard count ever written is accepted; a file claiming
        // another is corrupt and rebuilds rather than being guessed at.
        if (metadata.shardCount !== SHARD_COUNT) {
          this.logger.warn("Index shard count mismatch; rebuild required");
          return null;
        }
        chunks = [];
        for (let i = 0; i < SHARD_COUNT; i++) {
          const file = this.shardFile(i);
          // eslint-disable-next-line no-await-in-loop -- shards are read sequentially through the adapter
          if (!(await this.adapter.exists(file))) continue;
          // eslint-disable-next-line no-await-in-loop
          const parsed = JSON.parse(await this.adapter.read(file)) as IndexedChunk[];
          if (!Array.isArray(parsed)) {
            this.logger.warn("Index shard corrupt; rebuild required", { shard: i });
            return null;
          }
          chunks.push(...parsed);
        }
      } else {
        if (!(await this.adapter.exists(this.paths.chunksFile))) return null;
        const parsed = JSON.parse(await this.adapter.read(this.paths.chunksFile)) as IndexedChunk[];
        if (!Array.isArray(parsed)) {
          this.logger.warn("Index corrupt; rebuild required");
          return null;
        }
        chunks = parsed;
      }
      if (!chunks.every(isIndexedChunk)) {
        this.logger.warn("Index holds malformed chunks; rebuild required");
        return null;
      }
      this.layout = metadata.layout === "sharded" ? "sharded" : "single";
      this.dirtyShards.clear();
      this.allShardsDirty = false;
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
