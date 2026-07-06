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
import { chunkMarkdown, ChunkOptions } from "../core/markdown-chunker";
import { ScannedNote } from "./vault-scanner";
import { Logger, NULL_LOGGER } from "../utils/logger";

export const INDEX_VERSION = 1;

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
   * read as "added" on every refresh. Rebuilt from chunks on load(), so a
   * zero-chunk note reads as added once after a plugin reload, then settles.
   */
  private noteMtimes: Map<string, number> | null = null;
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
   */
  refresh(notes: ScannedNote[]): RefreshResult {
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
      if (priorMtime === note.mtime) {
        nextChunks.push(...(existingByNote.get(note.path) ?? []));
        result.unchanged++;
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
    await this.adapter.write(this.paths.metadataFile, JSON.stringify(this.index.metadata, null, 2));
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
      return this.index;
    } catch (err) {
      this.logger.warn("Failed to load index; rebuild required", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
