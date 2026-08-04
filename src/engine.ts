/**
 * EngramEngine — the orchestration facade shared by the UI commands and (from
 * M2) the local server. It owns the index, retriever, memory store and writer,
 * and rebuilds them whenever settings change. Keeping this Obsidian-agnostic
 * (it only needs a VaultAdapter) means the server can reuse it verbatim.
 */

import { VaultAdapter } from "./core/vault-adapter";
import { HttpClient } from "./core/http-client";
import { VaultScanner, ScannedNote } from "./indexing/vault-scanner";
import { TextExtractor } from "./extract/text-extractor";
import { ExtractionCache } from "./extract/extraction-cache";
import { extractMetadata } from "./core/metadata-extractor";
import { IndexManager, IndexedChunk, RefreshResult } from "./indexing/index-manager";
import { relatedNotes, RelatedNotes } from "./indexing/link-graph";
import { LexicalRetriever } from "./retrieval/lexical-retriever";
import { VectorRetriever } from "./retrieval/vector-retriever";
import { HybridRetriever } from "./retrieval/hybrid-retriever";
import { Retriever, RetrievalQuery, RetrievalResult } from "./retrieval/retriever";
import { EmbeddingProvider } from "./embeddings/embedding-provider";
import { EmbeddingStore, contentHash } from "./embeddings/embedding-store";
import { createEmbeddingProvider } from "./embeddings/provider-factory";
import {
  MemoryPaths,
  resolveMemoryPaths,
  MemoryEntry,
  resolveProjectPaths,
} from "./memory/memory-types";
import { MemoryStore, SessionNote, ContextPart } from "./memory/memory-store";
import { MemoryWriter } from "./memory/memory-writer";
import { ParsedInbox, PendingEntry } from "./memory/pending-inbox";
import { extractiveSummary, splitIntoSentences, SummaryMethod } from "./summarize/extractive";
import {
  EngramSettings,
  RetrievalMode,
  toScanConfig,
  toMemoryLayout,
  toEmbeddingConfig,
} from "./settings/settings";
import { normalizeVaultRelativePath, isInsideRoot, resolveInVault } from "./utils/paths";
import { ConfigError, toMessage } from "./utils/errors";
import { Logger } from "./utils/logger";

/** Optional injected dependencies (production wires the Obsidian adapters). */
export interface EngramEngineDeps {
  http?: HttpClient;
  /** Attachment text extractors (production: PDF via Obsidian's pdf.js). */
  extractors?: TextExtractor[];
}

/** Result of an extractive note summary. `sentences` are verbatim excerpts. */
export interface NoteSummary {
  notePath: string;
  sentences: string[];
  method: SummaryMethod;
  /** Candidate sentence-units the note yielded (before selection). */
  totalUnits: number;
  /** How many indexed chunks backed the summary. */
  chunkCount: number;
  /** True when the note had more units than the embedding cap and was truncated. */
  truncated: boolean;
}

export interface AddMemoryInput {
  type: MemoryEntry["type"];
  content: string;
  project?: string;
  source?: string;
  originTool?: string;
  confidence?: MemoryEntry["confidence"];
  tags?: string[];
  relatedPaths?: string[];
}

/** Default sentences returned by summarizeNote when the caller doesn't specify. */
const SUMMARY_DEFAULT_SENTENCES = 5;
const SUMMARY_MAX_SENTENCES = 20;
/** Upper bound on sentence-units embedded for a single summary, so a huge note
 * can't fan out into an unbounded embedding request. */
const SUMMARY_MAX_UNITS = 200;
/** Attachments above this size are skipped (whole-file reads into memory). */
const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
/**
 * Ceiling on the TEXT one attachment contributes.
 *
 * The 50 MB input cap above bounds what is read, not what comes back out, and
 * the two are only loosely related: the PDF and Office extractors cap pages and
 * parts, but a plain 50 MB csv, an RTF, or a docx whose whole body sits in one
 * `document.xml` had no bound at all. Unbounded, one such file becomes tens of
 * thousands of chunks — inflating the index, the search corpus, and (with a
 * provider configured) the number of embedding requests it costs.
 *
 * 1 MB comfortably holds a whole book's worth of extracted text (~2 000
 * characters a page over 500 pages), so real documents are unaffected.
 */
const EXTRACTED_TEXT_MAX_CHARS = 1024 * 1024;

/**
 * Clip extracted text to the ceiling, saying so in the text itself. Null stays
 * null: "no text found" must not become "a notice and nothing else", or an
 * image-only PDF would index as a document whose entire content is the notice.
 */
function capExtractedText(text: string | null): string | null {
  if (text === null || text.length <= EXTRACTED_TEXT_MAX_CHARS) return text;
  return `${text.slice(0, EXTRACTED_TEXT_MAX_CHARS)}\n\n(extraction truncated at ${EXTRACTED_TEXT_MAX_CHARS} characters)`;
}

export class EngramEngine {
  private settings: EngramSettings;
  private paths: MemoryPaths;
  private scanner: VaultScanner;
  private index: IndexManager;
  private store: MemoryStore;
  private writer: MemoryWriter;
  private retriever: Retriever;
  private embeddingStore: EmbeddingStore;
  private embeddingProvider: EmbeddingProvider | null;
  /** String snapshot of the embedding-related settings. Kept as OWN state —
   * never recomputed from `this.settings` at compare time — because the host
   * (Obsidian settings tab) mutates the one shared settings object in place,
   * so `this.settings` may alias the object passed to updateSettings. */
  private lastEmbeddingKey: string;
  private readonly http?: HttpClient;
  private readonly extractors: TextExtractor[];
  private extractionCache: ExtractionCache;
  /** One-shot guard so the disabled-path cache clear runs once, not per refresh. */
  private extractionCacheCleared = false;
  /** Serializes embedding passes so overlapping reindex/refresh/sync can't
   * interleave (last-writer-wins persist / mid-pass index mutation). */
  private embedChain: Promise<void> = Promise.resolve();
  /** Scan config in effect at the last completed scan. The skip-unchanged scan
   * fast path is only valid while the config is unchanged: known mtimes encode
   * eligibility verdicts under the config they were scanned with, and a note
   * that a NEW exclusion should hide must be re-checked, not skipped. String
   * snapshot (not object compare) for the same aliasing reason as
   * lastEmbeddingKey. Empty = no scan yet → next refresh reads everything. */
  private lastScanConfigKey = "";
  /** Scan config as of the last constructor/updateSettings call — detects a
   * scan-relevant settings CHANGE (vs lastScanConfigKey, which tracks what the
   * index was last scanned under). Own string state for the same in-place-
   * mutation aliasing reason as lastEmbeddingKey. */
  private lastScanSettingsKey: string;

  constructor(
    private readonly adapter: VaultAdapter,
    settings: EngramSettings,
    private readonly logger: Logger,
    private readonly clock: () => number = () => Date.now(),
    deps: EngramEngineDeps = {},
  ) {
    this.settings = settings;
    this.lastEmbeddingKey = embeddingKey(settings);
    this.lastScanSettingsKey = JSON.stringify(toScanConfig(settings));
    this.http = deps.http;
    this.extractors = deps.extractors ?? [];
    this.paths = EngramEngine.resolvePaths(settings);
    this.scanner = new VaultScanner(adapter, logger.child("scanner"));
    // Path-dependent components (built by wire()).
    this.index = this.newIndexManager();
    this.store = new MemoryStore(adapter, this.paths, logger.child("memory"));
    this.writer = this.buildWriter();
    this.embeddingStore = this.newEmbeddingStore();
    this.extractionCache = this.newExtractionCache();
    this.embeddingProvider = this.buildProvider();
    this.retriever = this.buildRetriever();
  }

  /** Validate + resolve the memory paths, throwing a clear error on bad config. */
  private static resolvePaths(settings: EngramSettings): MemoryPaths {
    try {
      normalizeVaultRelativePath(settings.memoryRoot);
    } catch {
      throw new ConfigError(
        `Memory root "${settings.memoryRoot}" is not a valid path inside the vault.`,
      );
    }
    return resolveMemoryPaths(settings.memoryRoot, toMemoryLayout(settings));
  }

  private newIndexManager(): IndexManager {
    return new IndexManager(this.adapter, this.paths, {
      logger: this.logger.child("index"),
      clock: this.clock,
    });
  }

  private newEmbeddingStore(): EmbeddingStore {
    return new EmbeddingStore(
      this.adapter,
      this.paths.embeddingsFile,
      this.logger.child("embeddings"),
    );
  }

  private newExtractionCache(): ExtractionCache {
    return new ExtractionCache(
      this.adapter,
      resolveInVault(this.paths.index, "extracted.json"),
      this.logger.child("extract"),
    );
  }

  /**
   * Attachment pass: extract text from eligible binary attachments and emit
   * them as ordinary ScannedNotes, so chunking, incremental refresh, exclusion
   * gating, retrieval, and every MCP tool treat them exactly like notes.
   * Extraction runs once per (path, mtime) — results (including "no text")
   * are cached in Index/extracted.json, so refreshes and plugin reloads
   * re-emit from cache without re-parsing.
   */
  private async scanAttachments(scanConfig: ReturnType<typeof toScanConfig>): Promise<ScannedNote[]> {
    if (!this.settings.indexAttachments || this.extractors.length === 0) {
      // Don't RETAIN extracted text after the feature is turned off — the
      // cache may hold content from sensitive PDFs. Cleared once per engine
      // lifetime while disabled (cheap no-op when already empty).
      if (!this.extractionCacheCleared) {
        this.extractionCacheCleared = true;
        await this.extractionCache.load();
        this.extractionCache.prune(new Set());
        await this.extractionCache.persist();
      }
      return [];
    }
    this.extractionCacheCleared = false;
    const extensions = this.extractors.flatMap((x) => x.extensions);
    const files = await this.adapter.listFilesByExtension(extensions);
    const eligible = files.filter(
      (f) => f.size <= ATTACHMENT_MAX_BYTES && this.scanner.isPathEligible(f.path, scanConfig),
    );
    await this.extractionCache.load();

    const out: ScannedNote[] = [];
    const live = new Set<string>();
    for (const f of eligible) {
      live.add(f.path);
      let entry = this.extractionCache.get(f.path, f.mtime);
      if (entry === undefined) {
        const lower = f.path.toLowerCase();
        const extractor = this.extractors.find((x) => x.extensions.some((e) => lower.endsWith(e)));
        let text: string | null = null;
        if (extractor) {
          try {
            // Extractors that work from the path alone (OCR delegates to a
            // companion plugin) get an empty buffer rather than a full read of
            // a file nobody will look at.
            const data =
              extractor.needsBytes === false
                ? new ArrayBuffer(0)
                : await this.adapter.readBinary(f.path);
            text = capExtractedText(await extractor.extract(f.path, data));
          } catch (err) {
            this.logger.warn(`Attachment extraction failed: ${f.path}`, {
              error: toMessage(err),
            });
          }
        }
        this.extractionCache.set(f.path, f.mtime, text);
        entry = { mtime: f.mtime, text };
      }
      if (entry.text) {
        const metadata = extractMetadata(entry.text);
        // Tag exclusions apply to extracted text exactly as to notes; checked
        // at emit time (not cached), so a tag-config change re-evaluates
        // without re-extraction.
        if (!this.scanner.isMetadataEligible(metadata, scanConfig)) continue;
        out.push({ path: f.path, mtime: f.mtime, content: entry.text, metadata });
      }
    }
    this.extractionCache.prune(live);
    await this.extractionCache.persist();
    return out;
  }

  /** Build the configured provider (null => lexical-only). */
  private buildProvider(): EmbeddingProvider | null {
    return createEmbeddingProvider(toEmbeddingConfig(this.settings), {
      http: this.http,
      logger: this.logger.child("embeddings"),
    });
  }

  /**
   * The retrieval mode actually in effect: with no usable provider we always
   * fall back to lexical, regardless of the configured mode.
   */
  private effectiveMode(): RetrievalMode {
    if (!this.embeddingProvider) return "lexical";
    return this.settings.retrievalMode;
  }

  private buildRetriever(): Retriever {
    const projectRootResolver = (p: string) => resolveProjectPaths(this.paths, p).folder;
    const mode = this.effectiveMode();
    if (mode === "vector") {
      return new VectorRetriever({ vectors: this.embeddingStore.vectorsMap(), projectRootResolver });
    }
    if (mode === "hybrid") {
      return new HybridRetriever({ vectors: this.embeddingStore.vectorsMap(), projectRootResolver });
    }
    return new LexicalRetriever({ projectRootResolver });
  }

  private buildWriter(): MemoryWriter {
    return new MemoryWriter(this.adapter, this.paths, {
      appendOnly: this.settings.appendOnly,
      allowDirectWrites: this.settings.allowDirectWrites,
      logger: this.logger.child("writer"),
    });
  }

  /**
   * Re-derive settings-dependent components after a settings change.
   *
   * The in-memory index is PRESERVED when the memory root is unchanged — only
   * the writer (whose append-only / direct-write options may have changed) is
   * rebuilt. When the root actually moves, the index legitimately points to a
   * new location and is reset; the host should then reload/reindex.
   *
   * @returns rootChanged — the memory root moved and the index was reset (the
   * host should reload/reindex); embeddingChanged — the embedding identity or
   * retrieval mode moved (the host should syncEmbeddings() in the background);
   * scanConfigChanged — the indexing eligibility rules moved (the host should
   * refresh so new exclusions actually drop notes from the index).
   */
  updateSettings(settings: EngramSettings): {
    rootChanged: boolean;
    embeddingChanged: boolean;
    scanConfigChanged: boolean;
  } {
    const previousRoot = this.paths.root;
    this.settings = settings;
    this.paths = EngramEngine.resolvePaths(settings);
    const rootChanged = this.paths.root !== previousRoot;
    const nextEmbeddingKey = embeddingKey(settings);
    const embeddingChanged = nextEmbeddingKey !== this.lastEmbeddingKey;
    this.lastEmbeddingKey = nextEmbeddingKey;
    const nextScanSettingsKey = JSON.stringify(toScanConfig(settings));
    const scanConfigChanged = nextScanSettingsKey !== this.lastScanSettingsKey;
    this.lastScanSettingsKey = nextScanSettingsKey;

    // Writer options can change without a root change, so always rebuild it.
    this.writer = this.buildWriter();

    if (rootChanged) {
      this.index = this.newIndexManager();
      this.store = new MemoryStore(this.adapter, this.paths, this.logger.child("memory"));
      this.embeddingStore = this.newEmbeddingStore();
      this.extractionCache = this.newExtractionCache();
      this.embeddingProvider = this.buildProvider();
      this.retriever = this.buildRetriever();
    } else if (embeddingChanged) {
      // Provider/model/endpoint/key/mode changed: rebuild the provider and
      // retriever in place. Existing vectors are kept; the host should call
      // syncEmbeddings() to (re)embed against the (possibly new) provider.
      this.embeddingProvider = this.buildProvider();
      this.retriever = this.buildRetriever();
    }
    return { rootChanged, embeddingChanged, scanConfigChanged };
  }

  getPaths(): MemoryPaths {
    return this.paths;
  }

  /**
   * Write a JSON backup of the current settings to Config/. Best-effort: a
   * failure here must never block the actual settings save, so callers should
   * catch. Provides a recovery point across settings migrations.
   */
  async backupSettings(snapshot: unknown): Promise<void> {
    await this.adapter.write(
      this.paths.settingsBackupFile,
      JSON.stringify(snapshot, null, 2),
    );
  }

  getMemoryStore(): MemoryStore {
    return this.store;
  }

  /** Create the base memory folder scaffold. */
  async ensureScaffold(): Promise<void> {
    await this.store.ensureScaffold();
  }

  /** Load a persisted index if present; returns true if one was loaded. */
  async loadIndex(): Promise<boolean> {
    const loaded = (await this.index.load()) !== null;
    if (loaded) {
      // A loaded index's eligibility verdicts were scanned under an UNKNOWN
      // config (e.g. a moved-back root's index persisted before an exclusion
      // was added). Reset the scan-key so the next refresh re-reads and
      // re-checks every note instead of trusting stubs against foreign
      // verdicts.
      this.lastScanConfigKey = "";
      // Bring the vector cache back into memory and rebuild the retriever so a
      // reloaded index can serve vector/hybrid results immediately.
      await this.embeddingStore.load();
      this.retriever = this.buildRetriever();
    }
    return loaded;
  }

  /** Full rebuild of the index from the current vault, then persist + embed. */
  async reindex(): Promise<{ noteCount: number; chunkCount: number }> {
    const scanConfig = toScanConfig(this.settings);
    const notes: ScannedNote[] = [
      ...(await this.scanner.scan(scanConfig)),
      ...(await this.scanAttachments(scanConfig)),
    ];
    this.extractionCache.consumeReset(); // a full build re-chunks everything
    this.lastScanConfigKey = JSON.stringify(scanConfig);
    const built = this.index.build(notes);
    await this.index.persist();
    this.logger.info("Reindexed vault", {
      notes: built.metadata.noteCount,
      chunks: built.metadata.chunkCount,
    });
    await this.embedIndex();
    return { noteCount: built.metadata.noteCount, chunkCount: built.metadata.chunkCount };
  }

  /** Incremental refresh (used by auto-index and manual refresh). */
  async refresh(): Promise<RefreshResult> {
    if (!this.index.getIndex()) {
      await this.reindex();
      return { added: this.index.getChunks().length, updated: 0, removed: 0, unchanged: 0 };
    }
    const scanConfig = toScanConfig(this.settings);
    const scanKey = JSON.stringify(scanConfig);
    // Skip-unchanged scanning keeps a debounced refresh O(changed) in file
    // I/O — but only while the scan config still matches the one the known
    // mtimes were scanned under (see lastScanConfigKey).
    const mdNotes =
      scanKey === this.lastScanConfigKey
        ? await this.scanner.scan(scanConfig, this.index.getNoteMtimes())
        : await this.scanner.scan(scanConfig);
    // Attachments do their own mtime short-circuit via the extraction cache,
    // so the fast path stays O(changed) for them too.
    const attachmentNotes = await this.scanAttachments(scanConfig);
    const notes = [...mdNotes, ...attachmentNotes];
    this.lastScanConfigKey = scanKey;
    // A discarded extraction cache (version bump / corrupt file) means the
    // re-extracted text can differ under an unchanged mtime — force those
    // notes past the index's mtime short-circuit once.
    const force = this.extractionCache.consumeReset()
      ? new Set(attachmentNotes.map((n) => n.path))
      : undefined;
    const result = this.index.refresh(notes, force);
    // Persist only when something changed: a no-op persist re-serializes the
    // whole index (tens of MB at scale) on the main thread, and — because the
    // index files live inside the vault — its own writes re-fire the vault
    // watcher and schedule the next debounced refresh, sustaining a
    // refresh/serialize/write cycle with auto-indexing on.
    if (result.added + result.updated + result.removed > 0) {
      await this.index.persist();
    }
    await this.embedIndex();
    return result;
  }

  /**
   * Search the current in-memory index. Async because vector/hybrid modes embed
   * the query first; lexical mode resolves without any network call.
   */
  async search(query: RetrievalQuery): Promise<RetrievalResult[]> {
    const resolved = await this.withQueryVector(query);
    return this.retriever.retrieve(resolved, this.index.getChunks());
  }

  /** Identity of the CURRENTLY-configured embedding backend. Stored vectors are
   * only trustworthy for a query when their identity matches this. Encodes
   * everything that changes embedding semantics; the endpoint and key are hashed
   * so no secret is derivable and none is written into the index. */
  private vectorIdentity(): string {
    const s = this.settings;
    return [
      s.embeddingProvider,
      s.embeddingModel,
      contentHash(s.embeddingEndpoint),
      contentHash(s.embeddingApiKey),
    ].join(":");
  }

  /** Attach a query embedding when a vector/hybrid retriever needs one. */
  private async withQueryVector(query: RetrievalQuery): Promise<RetrievalQuery> {
    if (query.queryVector) return query;
    if (this.effectiveMode() === "lexical" || !this.embeddingProvider) return query;
    if (!this.embeddingStore.hasVectors()) return query;
    // CRITICAL: only score the query against vectors produced by the SAME
    // backend. After a same-dimension model/endpoint swap (or a stale-on-disk
    // restart) the cached vectors are from another model; cosine would return
    // plausible-but-wrong scores. Degrade to lexical until a re-embed catches up.
    if (this.embeddingStore.identity() !== this.vectorIdentity()) {
      this.logger.warn("Embeddings are from a different backend; using lexical until re-embedded", {
        stored: this.embeddingStore.identity(),
      });
      return query;
    }
    try {
      const [vec] = await this.embeddingProvider.embed([query.query]);
      return vec ? { ...query, queryVector: vec } : query;
    } catch (err) {
      // Degrade to the lexical component rather than failing the search.
      this.logger.warn("Query embedding failed; using lexical ranking", {
        error: toMessage(err),
      });
      return query;
    }
  }

  /**
   * Compute/refresh vectors for the current index against the active provider,
   * then rebuild the retriever so new vectors are visible. Best-effort: if the
   * provider is unavailable or errors, we log and keep lexical retrieval — a
   * vector backend is never on the critical path.
   */
  async embedIndex(): Promise<void> {
    // Serialize passes: chain onto the previous one so two overlapping calls
    // (manual reindex + debounced refresh + settings-triggered sync) can never
    // interleave their snapshot/persist and clobber each other.
    const run = this.embedChain.then(() => this.doEmbedIndex());
    // Swallow on the chain so a failed pass doesn't reject the next one; callers
    // still observe this pass's outcome via the returned promise.
    this.embedChain = run.catch(() => undefined);
    return run;
  }

  private async doEmbedIndex(): Promise<void> {
    if (!this.embeddingProvider) return;
    const provider = this.embeddingProvider;
    try {
      if (!(await provider.isAvailable())) {
        this.logger.warn("Embedding provider unavailable; retrieval stays lexical", {
          provider: provider.id,
        });
        return;
      }
      // Snapshot chunks now so a concurrent index mutation can't shift them mid-pass.
      const chunks = this.index.getChunks().map((c) => ({ id: c.id, text: c.text }));
      const pass = await this.embeddingStore.embedIndex(chunks, provider, {
        batchSize: this.settings.embeddingBatchSize,
        identity: this.vectorIdentity(),
      });
      // Rebuild only when the pass changed vectors: the retriever snapshots the
      // vector map at build time, so an unchanged map needs no rebuild — and a
      // rebuild discards the lexical corpus-stats memo. (Vectors loaded from
      // disk are handled by loadIndex, which rebuilds itself.)
      if (pass.embedded > 0 || pass.removed > 0) {
        this.retriever = this.buildRetriever();
      }
    } catch (err) {
      this.logger.warn("Embedding pass failed; retrieval stays lexical", {
        error: toMessage(err),
      });
    }
  }

  /**
   * Called by the host after a settings change: ensure vectors exist for the
   * current provider. A no-op when no provider is configured.
   */
  async syncEmbeddings(): Promise<void> {
    await this.embedIndex();
  }

  /** The retrieval mode actually serving results (lexical when no provider). */
  getRetrievalMode(): RetrievalMode {
    return this.effectiveMode();
  }

  getIndexStats(): { noteCount: number; chunkCount: number; builtAt: number | null } {
    const idx = this.index.getIndex();
    return {
      noteCount: idx?.metadata.noteCount ?? 0,
      chunkCount: idx?.metadata.chunkCount ?? 0,
      builtAt: idx?.metadata.builtAt ?? null,
    };
  }

  /** The indexed chunks for a single note, in index order (empty if not indexed). */
  getNoteChunks(notePath: string): IndexedChunk[] {
    const normalized = normalizeVaultRelativePath(notePath);
    return this.index.getChunks().filter((c) => c.notePath === normalized);
  }

  /**
   * Notes related to an indexed note through the link graph: which indexed notes
   * it links to, and which indexed notes link back to it.
   *
   * SECURITY / scope: only an INDEXED note can be navigated (same gate as
   * summarizeNote); an excluded/unindexed note is refused. Resolution is over the
   * index only, so unresolved links (to excluded or non-existent notes) are
   * dropped and never surface.
   */
  getRelatedNotes(notePath: string): RelatedNotes {
    const normalized = normalizeVaultRelativePath(notePath);
    if (this.getNoteChunks(normalized).length === 0) {
      throw new ConfigError(
        `Note "${normalized}" is not indexed (it may be excluded or outside the vault). Only indexed notes can be navigated.`,
      );
    }
    return relatedNotes(normalized, this.index.getChunks());
  }

  /**
   * Extractive summary of an indexed note: a selection of the note's OWN
   * sentences, never generated prose (there is no LLM backend).
   *
   * SECURITY / scope: only notes that are IN the index can be summarized. A note
   * excluded from indexing (excluded folder/tag/path) has no chunks, so this
   * throws rather than reading it — the summary can never become a side channel
   * that exfiltrates a note the exclusion filters were meant to keep out.
   *
   * When an embedding provider is configured and reachable, sentence vectors
   * drive centroid + MMR selection; otherwise it degrades to lexical frequency
   * centrality. A provider error never fails the summary (fails open to lexical).
   */
  async summarizeNote(notePath: string, opts: { maxSentences?: number } = {}): Promise<NoteSummary> {
    const normalized = normalizeVaultRelativePath(notePath);
    const chunks = this.getNoteChunks(normalized);
    if (chunks.length === 0) {
      throw new ConfigError(
        `Note "${normalized}" is not indexed (it may be excluded or outside the vault). Only indexed notes can be summarized.`,
      );
    }
    const maxSentences = Math.max(
      1,
      Math.min(SUMMARY_MAX_SENTENCES, Math.trunc(opts.maxSentences ?? SUMMARY_DEFAULT_SENTENCES)),
    );

    // Build sentence units from the note's chunk text, de-duplicating the
    // repeats that overlapping chunks introduce (first occurrence wins so
    // original order is preserved).
    const seen = new Set<string>();
    const units: string[] = [];
    for (const chunk of chunks) {
      for (const sentence of splitIntoSentences(chunk.text)) {
        const key = sentence.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        units.push(sentence);
      }
    }

    const truncated = units.length > SUMMARY_MAX_UNITS;
    const bounded = truncated ? units.slice(0, SUMMARY_MAX_UNITS) : units;
    if (truncated) {
      this.logger.info("Summary units capped", { notePath: normalized, total: units.length, cap: SUMMARY_MAX_UNITS });
    }

    const vectors = await this.embedUnitsForSummary(bounded);
    const summary = extractiveSummary({ units: bounded, maxSentences, vectors });
    return {
      notePath: normalized,
      sentences: summary.sentences,
      method: summary.method,
      totalUnits: bounded.length,
      chunkCount: chunks.length,
      truncated,
    };
  }

  /**
   * Embed summary sentence-units when a provider is configured and reachable.
   * Returns undefined (=> lexical summary) if there is no provider, it's
   * unavailable, or embedding fails — summarization must never hard-fail on the
   * network, mirroring search's fail-open behavior.
   */
  private async embedUnitsForSummary(units: string[]): Promise<number[][] | undefined> {
    const provider = this.embeddingProvider;
    if (!provider || units.length === 0) return undefined;
    try {
      if (!(await provider.isAvailable())) return undefined;
      const vectors = await provider.embed(units);
      return vectors.length === units.length ? vectors : undefined;
    } catch (err) {
      this.logger.warn("Summary embedding failed; using lexical summary", {
        error: toMessage(err),
      });
      return undefined;
    }
  }

  /** Read + parse the review inbox for the richer per-entry review UI. */
  async getPendingMemory(): Promise<ParsedInbox> {
    return this.writer.readInbox();
  }

  /** Graduate a reviewed inbox entry into its destination memory file, then
   * drop it from the inbox. Human-in-the-loop; not exposed over the network. */
  async applyPendingMemory(entry: PendingEntry): Promise<{ destination: string }> {
    return this.writer.applyPending(entry);
  }

  /** Remove a reviewed inbox entry without applying it. */
  async discardPendingMemory(entry: PendingEntry): Promise<void> {
    await this.writer.discardPending(entry);
  }

  /** Propose a memory entry (to the inbox by default; direct write if enabled). */
  async addMemory(
    input: AddMemoryInput,
    opts: { direct?: boolean; subpath?: string } = {},
  ): Promise<{ path: string; duplicate: boolean }> {
    const entry: MemoryEntry = {
      type: input.type,
      content: input.content,
      project: input.project,
      source: input.source ?? "Obsidian UI",
      originTool: input.originTool,
      confidence: input.confidence,
      tags: input.tags ?? [],
      relatedPaths: input.relatedPaths ?? [],
      timestamp: this.clock(),
    };
    if (opts.direct && opts.subpath) {
      const path = await this.writer.directWrite(opts.subpath, entry);
      return { path, duplicate: false };
    }
    return this.writer.proposeToInbox(entry);
  }

  async createProject(name: string): Promise<string> {
    const project = await this.store.projects.createProject(name);
    return project.folder;
  }

  async listProjects(): Promise<string[]> {
    return this.store.listProjects();
  }

  async getProjectContext(name: string): Promise<ContextPart[]> {
    return this.store.getProjectContext(name);
  }

  async getGlobalContext(): Promise<ContextPart[]> {
    return this.store.getGlobalContext();
  }

  async getRecentSessions(name: string, limit?: number): Promise<SessionNote[]> {
    return this.store.getRecentSessions(name, limit);
  }

  async startSession(project: string, stamp: string): Promise<string> {
    return this.store.projects.startSession(project, stamp);
  }

  async endSession(sessionFile: string, summary: string): Promise<void> {
    // Only append to session notes that actually live under the projects root's
    // sessions folders — never to some unrelated vault note that merely has
    // "/sessions/" in its path.
    const normalized = normalizeVaultRelativePath(sessionFile);
    if (!isInsideRoot(this.paths.projects, normalized) || !normalized.includes("/sessions/")) {
      throw new ConfigError(
        "That note is not a project session note under the memory root.",
      );
    }
    await this.store.projects.endSession(normalized, summary);
  }
}

/**
 * Identity of the embedding-related settings — the single definition of "what
 * forces a re-embed". When this string changes, the provider and/or retriever
 * must be rebuilt and the host should re-embed via syncEmbeddings(). Batch
 * size is deliberately excluded: it changes only how embedding requests are
 * chunked, never the resulting vectors, so it must not force a re-embed.
 */
function embeddingKey(s: EngramSettings): string {
  return [
    s.embeddingProvider,
    s.embeddingModel,
    s.embeddingEndpoint,
    s.embeddingApiKey,
    s.retrievalMode,
  ].join(" ");
}
