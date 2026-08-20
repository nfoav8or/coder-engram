/**
 * EmbeddingStore — owns `Index/embeddings.json`: the per-chunk vector cache.
 *
 * Layout:
 *   { version, model, dim, vectors: { <chunkId>: { h: <contentHash>, v: number[] } } }
 *
 * `model` is the provider identity ("<id>:<model>"). If it changes, every vector
 * is stale and is recomputed. Per-chunk `h` is a content hash so an edited note
 * (same chunk id, new text) is re-embedded while untouched chunks are reused —
 * incremental, network-frugal embedding.
 *
 * Writes go exclusively through the injected VaultAdapter to the pre-resolved
 * in-vault embeddings path, so nothing here can escape the vault.
 */

import { VaultAdapter } from "../core/vault-adapter";
import { toMessage } from "../utils/errors";
import { Logger, NULL_LOGGER } from "../utils/logger";
import { EmbeddingProvider } from "./embedding-provider";

export const EMBED_STORE_VERSION = 1;

interface StoredVector {
  /** Content hash of the chunk text this vector was computed from. */
  h: string;
  v: number[];
}

interface StoredEmbeddings {
  version: number;
  model: string;
  dim: number;
  vectors: Record<string, StoredVector>;
}

/**
 * The stored vectors, checked to be what cosine scoring assumes.
 *
 * `embeddings.json` lives in the vault, so a sync conflict or another tool can
 * leave a file that still parses and still carries the right envelope. Checking
 * only `typeof vectors === "object"` let the contents through, and the failures
 * split two ways: an entry that is `null`, or missing `v`, threw out of
 * `vectorsMap()` and killed every vector and hybrid search; an array of the
 * wrong element type scored as `NaN`, which survives the retriever's
 * `score <= 0` filter (`NaN <= 0` is false) and sorts to an arbitrary rank, so
 * a corrupt vector shows up in results at a position nothing chose.
 *
 * Every element is checked, not just the array: at 19 000 vectors of 384
 * dimensions that costs ~28 ms against a ~500 ms parse, and a partial check is
 * how the contents got trusted in the first place.
 */
function isVectorMap(value: unknown): value is Record<string, StoredVector> {
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

export interface EmbedIndexResult {
  embedded: number;
  reused: number;
  removed: number;
  /** True when the provider was unavailable and nothing changed. */
  skipped: boolean;
}

export interface EmbedChunk {
  id: string;
  text: string;
}

export interface EmbedIndexOptions {
  batchSize?: number;
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
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function providerIdentity(provider: EmbeddingProvider): string {
  return `${provider.id}:${provider.model}`;
}

export class EmbeddingStore {
  private state: StoredEmbeddings | null = null;

  constructor(
    private readonly adapter: VaultAdapter,
    private readonly embeddingsFile: string,
    private readonly logger: Logger = NULL_LOGGER,
  ) {}

  /** Load persisted vectors; tolerant of a missing/corrupt/legacy file. */
  async load(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.embeddingsFile))) {
        this.state = null;
        return;
      }
      const raw = await this.adapter.read(this.embeddingsFile);
      const parsed = JSON.parse(raw) as Partial<StoredEmbeddings>;
      // Accept only the current shape; the M1/M2 placeholder shell
      // ({ model: null, dim: 0, vectors: {} }) and anything older is ignored.
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
      } else {
        this.state = null;
      }
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

  /** Live map of chunkId -> vector for the retriever. Empty when nothing is stored. */
  vectorsMap(): Map<string, number[]> {
    const map = new Map<string, number[]>();
    if (!this.state) return map;
    for (const [id, sv] of Object.entries(this.state.vectors)) {
      map.set(id, sv.v);
    }
    return map;
  }

  /** True once at least one vector is stored (retrieval can use vectors). */
  hasVectors(): boolean {
    return !!this.state && Object.keys(this.state.vectors).length > 0;
  }

  /** Forget all vectors in memory and on disk (used when disabling a provider). */
  async clear(): Promise<void> {
    this.state = null;
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
   * chunks, and recomputing everything if the provider identity changed. Embeds
   * in batches of `batchSize`. Persists once at the end.
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
    const identity = opts.identity ?? providerIdentity(provider);
    const identityChanged = !this.state || this.state.model !== identity;
    // Vectors reusable this pass: only when the provider identity is unchanged.
    const prior = identityChanged ? {} : this.state!.vectors;

    const nextVectors: Record<string, StoredVector> = {};
    const toEmbed: EmbedChunk[] = [];
    const toEmbedHash: string[] = [];
    let reused = 0;

    for (const chunk of chunks) {
      const h = chunkContentHash(chunk);
      const existing = prior[chunk.id];
      if (existing && existing.h === h) {
        nextVectors[chunk.id] = existing;
        reused++;
      } else {
        toEmbed.push(chunk);
        toEmbedHash.push(h);
      }
    }

    // `removed` = previously-stored chunk ids that no longer exist in the vault,
    // independent of whether their text changed or the provider identity moved.
    const currentIds = new Set(chunks.map((c) => c.id));
    const oldIds = this.state ? Object.keys(this.state.vectors) : [];
    const removed = oldIds.filter((id) => !currentIds.has(id)).length;
    let dim = identityChanged ? 0 : this.state?.dim ?? 0;
    let embedded = 0;

    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const batch = toEmbed.slice(i, i + batchSize);
      // eslint-disable-next-line no-await-in-loop -- batches are deliberately SEQUENTIAL: firing them all at once would flood the provider and blow past its rate limit
      const vectors = await provider.embed(batch.map((c) => c.text));
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
        const globalIndex = i + j;
        nextVectors[batch[j].id] = { h: toEmbedHash[globalIndex], v: vec };
        embedded++;
      }
    }

    this.state = { version: EMBED_STORE_VERSION, model: identity, dim, vectors: nextVectors };
    // Persist only when the on-disk file would actually differ. When nothing was
    // embedded or removed and the identity is unchanged, `nextVectors` is byte-for-
    // byte identical to what is already on disk (every chunk was reused), so a
    // full re-serialize + rewrite of a large embeddings.json (tens–hundreds of MB
    // at scale) on the main thread would be wasted work.
    if (embedded > 0 || removed > 0 || identityChanged) {
      await this.persist();
    }
    (opts.logger ?? this.logger).info("Embedded index", { embedded, reused, removed, dim });
    return { embedded, reused, removed, skipped: false };
  }

  private async persist(): Promise<void> {
    if (!this.state) return;
    await this.adapter.write(this.embeddingsFile, JSON.stringify(this.state));
  }
}
