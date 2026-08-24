/**
 * EmbeddingStore — owns `Index/embeddings.json`: the per-chunk vector cache.
 *
 * Layout (version 2):
 *   { version, model, dim, vectors: { <chunkId>: { h: <contentHash>, n: <norm>, v: <base64 f32> } } }
 *
 * `model` is the provider identity ("<id>:<model>"). If it changes, every vector
 * is stale and is recomputed. Per-chunk `h` is a content hash so an edited note
 * (same chunk id, new text) is re-embedded while untouched chunks are reused —
 * incremental, network-frugal embedding.
 *
 * Vectors are stored as base64-encoded little-endian Float32Array bytes, not
 * JSON number arrays: ~40% smaller on disk and far cheaper to parse — at large
 * vault scale the old number-array encoding made JSON.parse of this file the
 * dominant startup cost, and held every component as a boxed JS number on the
 * heap (8+ bytes each vs 4). `n` is the vector's Euclidean norm, precomputed at
 * embed time so cosine scoring never needs a corpus-wide norm pass. Version-1
 * files (number arrays) are migrated in place on load — no re-embed.
 *
 * Writes go exclusively through the injected VaultAdapter to the pre-resolved
 * in-vault embeddings path, so nothing here can escape the vault.
 */

import { VaultAdapter } from "../core/vault-adapter";
import { toMessage } from "../utils/errors";
import { fnv1a32 } from "../utils/hash";
import { Layout, SHARD_COUNT, chooseLayout, shardOf, shardPath } from "../utils/sharding";
import { Logger, NULL_LOGGER } from "../utils/logger";
import { EmbeddingProvider, VectorEntry, vectorNorm } from "./embedding-provider";

export const EMBED_STORE_VERSION = 2;

/**
 * Persist mid-pass roughly every this many newly embedded chunks. A large
 * vault's first pass runs for tens of minutes to hours on a CPU provider;
 * without checkpoints an Obsidian quit lost the whole pass (the store used to
 * persist only at the end) and the engine's pessimistic identity gate then
 * forced a full retry. Reuse-by-hash makes resume natural: the next pass
 * re-embeds only what a checkpoint didn't capture.
 */
const CHECKPOINT_CHUNKS = 1024;

interface StoredVector {
  /** Content hash of the chunk text this vector was computed from. */
  h: string;
  /** Euclidean norm, precomputed at embed time. */
  n: number;
  /** Base64 of the vector's little-endian Float32Array bytes. */
  v: string;
}

/** Version-1 entry shape (vectors as JSON number arrays), accepted at load. */
interface StoredVectorV1 {
  h: string;
  v: number[];
}

interface StoredEmbeddings {
  version: number;
  model: string;
  dim: number;
  vectors: Record<string, StoredVector>;
}

/** Above this many vectors the store persists as a vector-less manifest (the
 * embeddings file itself) plus shard files routed by chunk id — see
 * utils/sharding.ts for the layout rules shared with the chunk index. */
const SINGLE_FILE_MAX_VECTORS = 20_000;

/** The manifest written in place of the single file when sharded. */
interface ShardedManifest {
  version: number;
  model: string;
  dim: number;
  layout: "sharded";
  shardCount: number;
}

function encodeVector(vec: ArrayLike<number>): string {
  const f = vec instanceof Float32Array ? vec : new Float32Array(vec);
  const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  let bin = "";
  const STRIDE = 0x8000; // String.fromCharCode arg-count limit
  for (let i = 0; i < bytes.length; i += STRIDE) {
    bin += String.fromCharCode(...bytes.subarray(i, i + STRIDE));
  }
  return btoa(bin);
}

function decodeVector(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

const BASE64_SHAPE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded byte length of a shape-valid base64 string. */
function base64ByteLength(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

/**
 * The stored vectors, checked to be what cosine scoring assumes.
 *
 * `embeddings.json` lives in the vault, so a sync conflict or another tool can
 * leave a file that still parses and still carries the right envelope. Every
 * entry is checked, not just the map shape — a partial check is how the
 * contents got trusted in the first place (see the 0.10.3 cache hardening).
 * The base64 payload is validated by charset/length here (cheap, linear) and
 * by finiteness at decode time in `entriesMap`, which preserves the original
 * guarantee that a corrupt vector can never score as NaN and sort into results.
 */
function isVectorMap(value: unknown): value is Record<string, StoredVector> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  for (const entry of Object.values(value)) {
    if (typeof entry !== "object" || entry === null) return false;
    const stored = entry as Record<string, unknown>;
    if (typeof stored.h !== "string") return false;
    if (typeof stored.n !== "number" || !Number.isFinite(stored.n)) return false;
    if (typeof stored.v !== "string" || stored.v.length % 4 !== 0 || !BASE64_SHAPE.test(stored.v)) {
      return false;
    }
    // Padding can leave a shape-valid string decoding to a byte count that is
    // not a float boundary; `new Float32Array(buffer)` throws on that, and
    // the decode runs unguarded at retriever build time.
    if (base64ByteLength(stored.v) % 4 !== 0) return false;
  }
  return true;
}

/** The version-1 shape (number-array vectors), for in-place migration. */
function isVectorMapV1(value: unknown): value is Record<string, StoredVectorV1> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  for (const entry of Object.values(value)) {
    if (typeof entry !== "object" || entry === null) return false;
    const stored = entry as Record<string, unknown>;
    if (typeof stored.h !== "string" || !Array.isArray(stored.v)) return false;
    for (const component of stored.v) {
      if (typeof component !== "number" || !Number.isFinite(component)) return false;
    }
  }
  return true;
}

interface EmbedIndexResult {
  embedded: number;
  reused: number;
  removed: number;
  /** True when the provider was unavailable and nothing changed. */
  skipped: boolean;
}

interface EmbedChunk {
  id: string;
  text: string;
}

interface EmbedIndexOptions {
  batchSize?: number;
  /**
   * Concurrent embed batches in flight (default 1 — strictly sequential).
   * Raise only for a LOCAL provider (Ollama): localhost has no rate limit and
   * roughly doubles throughput at 2–4; a SaaS endpoint keeps 1 so the pass
   * cannot flood a rate-limited API.
   */
  concurrency?: number;
  logger?: Logger;
  /**
   * Cache identity for these vectors. When it differs from the stored identity,
   * every vector is recomputed. Must encode EVERYTHING that changes embedding
   * semantics (provider, model, endpoint, key) — NOT just id:model — so an
   * endpoint/key swap invalidates the cache. Defaults to "<id>:<model>".
   */
  identity?: string;
}

/**
 * Content hashes memoized by chunk object identity. IndexManager.refresh keeps
 * the same chunk objects for unchanged notes, so across refreshes only chunks
 * from actually-edited notes miss here — without this, every pass re-hashed the
 * full corpus text to decide that almost all of it was reusable. Callers that
 * build fresh chunk objects (tests) just miss the cache and pay the hash once.
 */
const hashCache = new WeakMap<EmbedChunk, string>();

function chunkContentHash(chunk: EmbedChunk): string {
  let h = hashCache.get(chunk);
  if (h === undefined) {
    h = contentHash(chunk.text);
    hashCache.set(chunk, h);
  }
  return h;
}

/** FNV-1a 32-bit hash of a string, hex-encoded. Deterministic, dependency-free. */
export function contentHash(text: string): string {
  return fnv1a32(text).toString(16);
}

function providerIdentity(provider: EmbeddingProvider): string {
  return `${provider.id}:${provider.model}`;
}

export class EmbeddingStore {
  private state: StoredEmbeddings | null = null;
  /** Decoded entries for the CURRENT state object; rebuilt when state swaps. */
  private decoded: { state: StoredEmbeddings; map: Map<string, VectorEntry> } | null = null;
  /** Layout of the current on-disk files; recorded, never re-derived (see
   * IndexManager for the same pattern and rationale). */
  private layout: Layout = "single";
  private dirtyShards = new Set<number>();
  private allShardsDirty = true;
  /** Serializes persists so a checkpoint landing while another persist is
   * mid-write cannot interleave shard files. */
  private persistChain: Promise<void> = Promise.resolve();
  private readonly singleFileMaxVectors: number;

  constructor(
    private readonly adapter: VaultAdapter,
    private readonly embeddingsFile: string,
    private readonly logger: Logger = NULL_LOGGER,
    options: { singleFileMaxVectors?: number } = {},
  ) {
    this.singleFileMaxVectors = options.singleFileMaxVectors ?? SINGLE_FILE_MAX_VECTORS;
  }

  private shardFile(i: number): string {
    return shardPath(this.embeddingsFile, i);
  }

  /** Load persisted vectors; tolerant of a missing/corrupt/legacy file. */
  async load(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.embeddingsFile))) {
        this.state = null;
        return;
      }
      const raw = await this.adapter.read(this.embeddingsFile);
      const parsed = JSON.parse(raw) as Partial<StoredEmbeddings> & Partial<ShardedManifest>;
      if (
        parsed.layout === "sharded" &&
        parsed.version === EMBED_STORE_VERSION &&
        typeof parsed.model === "string" &&
        typeof parsed.dim === "number" &&
        parsed.shardCount === SHARD_COUNT
      ) {
        // Sharded layout: the file above is a vector-less manifest; vectors
        // live in the shard files. A corrupt shard drops only ITS vectors
        // (re-embedded on the next pass) — unlike the chunk index, a full
        // rebuild here costs real provider work, so damage stays local.
        const vectors: Record<string, StoredVector> = {};
        let droppedShards = 0;
        for (let i = 0; i < SHARD_COUNT; i++) {
          const file = this.shardFile(i);
          // eslint-disable-next-line no-await-in-loop -- shards are read sequentially through the adapter
          if (!(await this.adapter.exists(file))) {
            // Every shard exists once the layout is adopted; a missing one is
            // damage. Harmless here (its vectors simply re-embed) but logged
            // so the re-embed pass that follows is explained.
            droppedShards++;
            this.logger.warn("Embedding shard missing; its vectors will re-embed", { shard: i });
            continue;
          }
          try {
            // eslint-disable-next-line no-await-in-loop -- shards are read sequentially through the adapter, same as the exists() check above
            const shard = JSON.parse(await this.adapter.read(file)) as unknown;
            if (!isVectorMap(shard)) throw new Error("malformed shard");
            Object.assign(vectors, shard);
          } catch (err) {
            droppedShards++;
            this.logger.warn("Dropped corrupt embedding shard; its vectors will re-embed", {
              shard: i,
              error: toMessage(err),
            });
          }
        }
        if (droppedShards > 0) {
          this.logger.warn("Embedding shards dropped at load", { droppedShards, of: SHARD_COUNT });
        }
        this.state = {
          version: EMBED_STORE_VERSION,
          model: parsed.model,
          dim: parsed.dim,
          vectors,
        };
        this.layout = "sharded";
        this.dirtyShards.clear();
        this.allShardsDirty = false;
        return;
      }
      if (
        parsed.version === EMBED_STORE_VERSION &&
        typeof parsed.model === "string" &&
        typeof parsed.dim === "number" &&
        isVectorMap(parsed.vectors)
      ) {
        this.state = {
          version: EMBED_STORE_VERSION,
          model: parsed.model,
          dim: parsed.dim,
          vectors: parsed.vectors,
        };
        this.layout = "single";
        this.dirtyShards.clear();
        this.allShardsDirty = false;
        return;
      }
      // Version-1 file (JSON number-array vectors): migrate in place so an
      // upgrading user keeps every vector instead of paying a full re-embed.
      if (
        parsed.version === 1 &&
        typeof parsed.model === "string" &&
        typeof parsed.dim === "number" &&
        isVectorMapV1(parsed.vectors)
      ) {
        const vectors: Record<string, StoredVector> = {};
        for (const [id, sv] of Object.entries(parsed.vectors)) {
          vectors[id] = { h: sv.h, n: vectorNorm(sv.v), v: encodeVector(sv.v) };
        }
        this.state = { version: EMBED_STORE_VERSION, model: parsed.model, dim: parsed.dim, vectors };
        await this.persist();
        this.logger.info("Migrated embeddings cache to v2 (binary vectors)", {
          vectors: Object.keys(vectors).length,
        });
        return;
      }
      this.state = null;
    } catch (err) {
      this.logger.warn("Failed to load embeddings; will recompute", {
        error: toMessage(err),
      });
      this.state = null;
    }
  }

  /** Cache identity of the stored vectors, or null when nothing is stored. */
  identity(): string | null {
    return this.state?.model ?? null;
  }

  /** Dimensionality of the stored vectors, or 0 when nothing is stored. */
  dim(): number {
    return this.state?.dim ?? 0;
  }

  /**
   * Live map of chunkId -> decoded vector + norm for the retriever. Decoding is
   * memoized by state identity, so repeated retriever rebuilds over an
   * unchanged store decode the corpus once. An entry whose bytes decode to the
   * wrong dimensionality or to non-finite components is dropped (with a log),
   * never served — a NaN score survives the retriever's `score <= 0` filter and
   * would sort into results at an arbitrary rank.
   */
  entriesMap(): Map<string, VectorEntry> {
    if (!this.state) return new Map();
    if (this.decoded && this.decoded.state === this.state) return this.decoded.map;
    const map = new Map<string, VectorEntry>();
    let dropped = 0;
    for (const [id, sv] of Object.entries(this.state.vectors)) {
      const vec = decodeVector(sv.v);
      if (vec.length !== this.state.dim) {
        dropped++;
        continue;
      }
      let finite = true;
      for (let i = 0; i < vec.length; i++) {
        if (!Number.isFinite(vec[i])) {
          finite = false;
          break;
        }
      }
      if (!finite) {
        dropped++;
        continue;
      }
      map.set(id, { vec, norm: sv.n });
    }
    if (dropped > 0) {
      this.logger.warn("Dropped corrupt embedding entries", { dropped });
    }
    this.decoded = { state: this.state, map };
    return map;
  }

  /** True once at least one vector is stored (retrieval can use vectors). */
  hasVectors(): boolean {
    return !!this.state && Object.keys(this.state.vectors).length > 0;
  }

  /** Forget all vectors in memory and on disk (used when disabling a provider). */
  async clear(): Promise<void> {
    this.state = null;
    this.decoded = null;
    if (this.layout === "sharded") {
      for (let i = 0; i < SHARD_COUNT; i++) {
        // eslint-disable-next-line no-await-in-loop -- rare user action; sequential adapter writes
        await this.adapter.write(this.shardFile(i), "{}");
      }
    }
    this.layout = "single";
    this.dirtyShards.clear();
    this.allShardsDirty = true;
    if (await this.adapter.exists(this.embeddingsFile)) {
      await this.adapter.write(
        this.embeddingsFile,
        JSON.stringify({ version: EMBED_STORE_VERSION, model: "", dim: 0, vectors: {} }, null, 2),
      );
    }
  }

  /**
   * Ensure every chunk has an up-to-date vector for `provider`, reusing cached
   * vectors whose content hash is unchanged, dropping vectors for removed
   * chunks, and recomputing everything if the provider identity changed.
   * Embeds in batches of `batchSize`, up to `concurrency` batches in flight,
   * and checkpoints progress every ~CHECKPOINT_CHUNKS newly embedded chunks so
   * an interrupted long pass resumes instead of restarting.
   *
   * The caller is responsible for checking `provider.isAvailable()` first; any
   * network error here propagates so the caller can degrade to lexical.
   */
  async embedIndex(
    chunks: EmbedChunk[],
    provider: EmbeddingProvider,
    opts: EmbedIndexOptions = {},
  ): Promise<EmbedIndexResult> {
    const batchSize = Math.max(1, opts.batchSize ?? 16);
    const concurrency = Math.max(1, opts.concurrency ?? 1);
    const identity = opts.identity ?? providerIdentity(provider);
    const identityChanged = !this.state || this.state.model !== identity;
    // Vectors reusable this pass: only when the provider identity is unchanged.
    const prior = identityChanged ? {} : this.state!.vectors;

    const nextVectors: Record<string, StoredVector> = {};
    const toEmbed: Array<{ chunk: EmbedChunk; hash: string }> = [];
    let reused = 0;

    for (const chunk of chunks) {
      const h = chunkContentHash(chunk);
      const existing = prior[chunk.id];
      if (existing && existing.h === h) {
        nextVectors[chunk.id] = existing;
        reused++;
      } else {
        toEmbed.push({ chunk, hash: h });
      }
    }

    // `removed` = previously-stored chunk ids that no longer exist in the vault,
    // independent of whether their text changed or the provider identity moved.
    const currentIds = new Set(chunks.map((c) => c.id));
    const oldIds = this.state ? Object.keys(this.state.vectors) : [];
    let removed = 0;
    for (const id of oldIds) {
      if (!currentIds.has(id)) {
        removed++;
        this.dirtyShards.add(shardOf(id));
      }
    }
    if (identityChanged) this.allShardsDirty = true;
    let dim = identityChanged ? 0 : this.state?.dim ?? 0;
    let embedded = 0;
    let sinceCheckpoint = 0;

    const batches: Array<Array<{ chunk: EmbedChunk; hash: string }>> = [];
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      batches.push(toEmbed.slice(i, i + batchSize));
    }

    let cursor = 0;
    // Normalized to an Error at capture time: a provider that rejects with a
    // non-Error (a string, a response object) would otherwise be rethrown as
    // that value, and every caller here treats a failure as an Error.
    let failed: Error | null = null;
    const worker = async () => {
      // eslint-disable-next-line no-constant-condition -- take-next-batch pool
      while (true) {
        if (failed !== null) return;
        const index = cursor++;
        if (index >= batches.length) return;
        const batch = batches[index];
        try {
          // eslint-disable-next-line no-await-in-loop -- each worker is deliberately sequential; parallelism is capped by the worker COUNT so a rate-limited provider is never flooded
          const vectors = await provider.embed(batch.map((b) => b.chunk.text));
          if (vectors.length !== batch.length) {
            throw new Error(
              `Embedding provider returned ${vectors.length} vectors for ${batch.length} inputs`,
            );
          }
          for (let j = 0; j < batch.length; j++) {
            const vec = vectors[j];
            if (dim === 0) dim = vec.length;
            else if (vec.length !== dim) {
              throw new Error("Embedding provider returned inconsistent vector dimensions");
            }
            const f32 = new Float32Array(vec);
            const id = batch[j].chunk.id;
            nextVectors[id] = {
              h: batch[j].hash,
              n: vectorNorm(f32),
              v: encodeVector(f32),
            };
            this.dirtyShards.add(shardOf(id));
            embedded++;
            sinceCheckpoint++;
          }
          if (sinceCheckpoint >= CHECKPOINT_CHUNKS) {
            sinceCheckpoint = 0;
            // Snapshot what is done so far (reused + embedded-to-date). Ids not
            // yet embedded are simply absent — a resumed pass re-embeds only
            // those. JSON.stringify is synchronous, so the snapshot is
            // consistent even with other batches in flight.
            this.state = { version: EMBED_STORE_VERSION, model: identity, dim, vectors: { ...nextVectors } };
            this.decoded = null;
            // eslint-disable-next-line no-await-in-loop -- checkpoint write is intentionally on the embedding path: losing an hours-long pass costs more than a periodic serialize
            await this.persist();
            (opts.logger ?? this.logger).info("Embedding checkpoint", { embedded, remaining: toEmbed.length - embedded });
          }
        } catch (err) {
          if (failed === null) failed = err instanceof Error ? err : new Error(toMessage(err));
          return;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, Math.max(1, batches.length)) }, () => worker()),
    );
    if (failed !== null) throw failed;

    this.state = { version: EMBED_STORE_VERSION, model: identity, dim, vectors: nextVectors };
    this.decoded = null;
    // Persist only when the on-disk file would actually differ. When nothing was
    // embedded or removed and the identity is unchanged, `nextVectors` is byte-for-
    // byte identical to what is already on disk (every chunk was reused), so a
    // full re-serialize + rewrite of a large embeddings.json on the main thread
    // would be wasted work.
    if (embedded > 0 || removed > 0 || identityChanged) {
      await this.persist();
    }
    (opts.logger ?? this.logger).info("Embedded index", { embedded, reused, removed, dim });
    return { embedded, reused, removed, skipped: false };
  }

  /** Persists are chained: a checkpoint can land while a previous persist is
   * still writing shards, and interleaved writes would tear the layout. */
  private persist(): Promise<void> {
    // Run after the previous persist settles either way: chaining only on
    // fulfilment would let one failed checkpoint reject every later persist
    // without running it, silently ending persistence for the session.
    const run = () => this.doPersist();
    this.persistChain = this.persistChain.then(run, run);
    return this.persistChain;
  }

  private async doPersist(): Promise<void> {
    if (!this.state) return;
    const state = this.state;
    const count = Object.keys(state.vectors).length;
    const layout = chooseLayout(this.layout, count, this.singleFileMaxVectors);
    const switching = layout !== this.layout;
    if (switching) {
      this.logger.info("Embeddings layout switch", { from: this.layout, to: layout, vectors: count });
    }
    // Snapshot-and-clear up front so shards dirtied WHILE this persist writes
    // stay marked for the next one; a failed persist falls back to
    // rewrite-everything rather than silently under-writing.
    const writeAll = switching || this.allShardsDirty;
    const dirty = new Set(this.dirtyShards);
    this.dirtyShards.clear();
    this.allShardsDirty = false;
    try {
      if (layout === "single") {
        await this.adapter.write(this.embeddingsFile, JSON.stringify(state));
        if (switching) {
          // No delete on the adapter (nothing in this plugin destroys files);
          // obsolete shards are blanked to a sentinel the loader never reads.
          for (let i = 0; i < SHARD_COUNT; i++) {
            // eslint-disable-next-line no-await-in-loop -- rare one-time layout downgrade
            await this.adapter.write(this.shardFile(i), "{}");
          }
        }
      } else {
        // Group only the entries that will be written. The O(vectors) key scan
        // per persist is trivial beside the embedding work between persists.
        const groups = new Map<number, Record<string, StoredVector>>();
        for (const [id, sv] of Object.entries(state.vectors)) {
          const shard = shardOf(id);
          if (!writeAll && !dirty.has(shard)) continue;
          let group = groups.get(shard);
          if (!group) groups.set(shard, (group = {}));
          group[id] = sv;
        }
        const targets = writeAll ? Array.from({ length: SHARD_COUNT }, (_, i) => i) : [...dirty];
        for (const i of targets) {
          // eslint-disable-next-line no-await-in-loop -- sequential adapter writes on purpose
          await this.adapter.write(this.shardFile(i), JSON.stringify(groups.get(i) ?? {}));
        }
        const manifest: ShardedManifest = {
          version: EMBED_STORE_VERSION,
          model: state.model,
          dim: state.dim,
          layout: "sharded",
          shardCount: SHARD_COUNT,
        };
        await this.adapter.write(this.embeddingsFile, JSON.stringify(manifest));
        this.logger.info("Persisted embedding shards", { written: targets.length, of: SHARD_COUNT });
      }
      this.layout = layout;
    } catch (err) {
      this.allShardsDirty = true;
      throw err;
    }
  }
}
