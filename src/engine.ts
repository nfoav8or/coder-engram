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
import { candidateDepthFor, fuseByRank } from "./retrieval/ranking";
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
import { ApplyOutcome, InboxLock, MemoryWriter, RejectionMatch } from "./memory/memory-writer";
import {
  parseSupersedesRef,
  stripSupersededSections,
  supersessionKey,
} from "./memory/supersession";
import { findSimilarMemory } from "./memory/conflict";
import { applyMemoryDecay } from "./memory/decay";
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
import { foldForCompare, projectKey } from "./utils/text";
import { ConfigError, ValidationError, toMessage } from "./utils/errors";
import { Logger, redact } from "./utils/logger";

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

/**
 * What an embedding pass actually did, so the caller can tell the user the
 * truth. Every failure here is non-fatal by design (retrieval degrades to
 * lexical), which previously meant they were all indistinguishable from
 * success at the call site — the UI reported "Embeddings updated" even when
 * the provider was unreachable and nothing was computed.
 */
export interface EmbedPassResult {
  outcome: "embedded" | "no-provider" | "unavailable" | "failed" | "superseded";
  embedded: number;
  reused: number;
  /** Provider id, or an error message — whatever makes the outcome actionable. */
  detail?: string;
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
  /** `<vault path>#<heading>` of the memory this entry replaces, if any. */
  supersedes?: string;
}

/**
 * Memory chunks scored for overlap against a new proposal. The check only ever
 * reports the single strongest match, so this is how deep to look for it, not a
 * page size — enough that the right memory is in the set when the proposal's
 * wording is not the best query for it.
 */
const SIMILARITY_CANDIDATES = 10;

/** Default sentences returned by summarizeNote when the caller doesn't specify. */
const SUMMARY_DEFAULT_SENTENCES = 5;
const SUMMARY_MAX_SENTENCES = 20;
/** Upper bound on sentence-units embedded for a single summary, so a huge note
 * can't fan out into an unbounded embedding request. */
const SUMMARY_MAX_UNITS = 200;
/** Attachments above this size are skipped (whole-file reads into memory). */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
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
 * Ceiling on the text ALL attachments together contribute to one scan.
 *
 * Per-file caps bound one document; they say nothing about a thousand of them.
 * Both the extraction cache and the index are single JSON documents, and V8
 * refuses to build a string past ~512 MB: 516 attachments at the per-file
 * ceiling make `JSON.stringify` throw `RangeError: Invalid string length`
 * (measured), which aborts the whole refresh rather than degrading — the vault
 * can then never finish indexing.
 *
 * 32 MB is roughly 8 million tokens of attachment text, far past what
 * retrieval usefully serves, and an order of magnitude under the failure
 * point even after JSON escaping and chunk overlap. Attachments past it are
 * skipped in scan order (stable across runs) and logged, so the outcome is a
 * bounded, self-describing partial index instead of no index at all.
 */
export const ATTACHMENT_TEXT_BUDGET_CHARS = 32 * 1024 * 1024;

/**
 * Per-note chunk lookup, memoized by chunks-array identity (the same
 * invalidation contract as the link-graph and corpus-stats caches: refresh
 * keeps the array on a no-op and swaps it on any change). getNoteChunks backs
 * three rate-limited MCP handlers, so without this each request re-scanned the
 * whole corpus to pull one note's chunks.
 */
const noteChunksCache = new WeakMap<IndexedChunk[], Map<string, IndexedChunk[]>>();

function chunksByNote(chunks: IndexedChunk[]): Map<string, IndexedChunk[]> {
  let byNote = noteChunksCache.get(chunks);
  if (byNote === undefined) {
    byNote = new Map();
    for (const chunk of chunks) {
      const list = byNote.get(chunk.notePath);
      if (list) list.push(chunk);
      else byNote.set(chunk.notePath, [chunk]);
    }
    noteChunksCache.set(chunks, byNote);
  }
  return byNote;
}

/**
 * Clip extracted text to the ceiling, saying so in the text itself. Null stays
 * null: "no text found" must not become "a notice and nothing else", or an
 * image-only PDF would index as a document whose entire content is the notice.
 */
function capExtractedText(text: string | null): string | null {
  if (text === null || text.length <= EXTRACTED_TEXT_MAX_CHARS) return text;
  return `${text.slice(0, EXTRACTED_TEXT_MAX_CHARS)}\n\n(extraction truncated at ${EXTRACTED_TEXT_MAX_CHARS} characters)`;
}

/**
 * Narrow an inbox-format parse to one project. The inbox and the rejection
 * ledger answer "does this entry belong to project X" the same way, folded for
 * case and Unicode form like every other project comparison — one answer, so
 * the two files cannot drift apart on it. A blank project means every entry.
 */
function filterByProject(parsed: ParsedInbox, project: string | undefined): ParsedInbox {
  const wanted = (project ?? "").trim();
  if (wanted === "") return parsed;
  const folded = foldForCompare(wanted);
  return {
    ...parsed,
    entries: parsed.entries.filter((e) => foldForCompare(e.project ?? "") === folded),
  };
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
  /**
   * Attachments the last scan left out because the corpus text budget was
   * spent. Surfaced in the index stats: a partial index the user cannot see is
   * indistinguishable from a document that simply will not match.
   */
  private skippedAttachments = 0;
  /** Serializes embedding passes so overlapping reindex/refresh/sync can't
   * interleave (last-writer-wins persist / mid-pass index mutation). */
  private embedChain: Promise<unknown> = Promise.resolve();
  /** Serializes reindex/refresh. `IndexManager.build`/`refresh` yield to the
   * event loop mid-pass, so two overlapping calls (auto-index debounce +
   * settings-triggered refresh + the `reindex_vault` tool) would otherwise
   * interleave their scans and mutate one index concurrently. */
  private indexChain: Promise<unknown> = Promise.resolve();
  /** Vector identity of the last COMPLETED embedding pass; null when the last
   * pass failed, was skipped (provider unavailable), or none has run. Lets a
   * no-op refresh skip the pass entirely — the pass re-hashes every chunk in
   * the corpus even when nothing needs embedding, which is O(vault) synchronous
   * work on the majority of debounced refreshes. Null forces a retry. */
  private lastEmbeddedIdentity: string | null = null;
  /** Outlives the writers it is handed to: updateSettings rebuilds the writer,
   * and the inbox file needs one serializer across all of them. */
  private readonly inboxLock = new InboxLock();
  /** Scan config in effect at the last completed scan. The skip-unchanged scan
   * fast path is only valid while the config is unchanged: known mtimes encode
   * eligibility verdicts under the config they were scanned with, and a note
   * that a NEW exclusion should hide must be re-checked, not skipped. String
   * snapshot (not object compare) for the same aliasing reason as
   * lastEmbeddingKey. Empty = no scan yet → next refresh reads everything. */
  private lastScanConfigKey = "";
  /** Scan-relevant settings as of the last constructor/updateSettings call —
   * detects a settings CHANGE (vs lastScanConfigKey, which tracks what the
   * index was last scanned under, and is a different, narrower key: see
   * scanSettingsKey). Own string state for the same in-place-mutation aliasing
   * reason as lastEmbeddingKey. */
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
    this.lastScanSettingsKey = scanSettingsKey(settings);
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
      this.skippedAttachments = 0;
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
    const eligibleByPath = this.scanner.pathEligibility(scanConfig);
    const eligible = files.filter(
      (f) => f.size <= ATTACHMENT_MAX_BYTES && eligibleByPath(f.path),
    );
    // Bound for the whole pass, like the index in doReindex: a root change
    // mid-scan swaps this.extractionCache, and entries written to the old
    // instance after that would never be persisted — every attachment
    // re-extracted on the next pass for nothing.
    const cache = this.extractionCache;
    await cache.load();

    const out: ScannedNote[] = [];
    const live = new Set<string>();
    // Corpus-wide budget: files past it are neither extracted nor cached, and
    // leaving them out of `live` also drops any text a previous, smaller vault
    // had cached for them.
    let remainingChars = ATTACHMENT_TEXT_BUDGET_CHARS;
    let skippedForBudget = 0;
    for (const f of eligible) {
      if (remainingChars <= 0) {
        skippedForBudget++;
        continue;
      }
      live.add(f.path);
      let entry = cache.get(f.path, f.mtime);
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
        cache.set(f.path, f.mtime, text);
        entry = { mtime: f.mtime, text };
      }
      if (entry.text) {
        remainingChars -= entry.text.length;
        // Derived once per (path, mtime) and cached with the text: this pass
        // runs over EVERY attachment on every refresh, while the markdown side
        // is O(changed), so re-deriving it here costs ~700 ms at the corpus
        // budget for text that did not change.
        let metadata = entry.metadata;
        if (metadata === undefined) {
          metadata = extractMetadata(entry.text);
          cache.rememberMetadata(f.path, metadata);
        }
        // Tag exclusions apply to extracted text exactly as to notes; checked
        // at emit time (not cached), so a tag-config change re-evaluates
        // without re-extraction.
        if (!this.scanner.isMetadataEligible(metadata, scanConfig)) continue;
        out.push({ path: f.path, mtime: f.mtime, content: entry.text, metadata });
      }
    }
    this.skippedAttachments = skippedForBudget;
    if (skippedForBudget > 0) {
      this.logger.warn(
        `Attachment text budget reached; ${skippedForBudget} attachment(s) not indexed`,
        { budgetChars: ATTACHMENT_TEXT_BUDGET_CHARS },
      );
    }
    cache.prune(live);
    await cache.persist();
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
      return new VectorRetriever({ vectors: this.embeddingStore.entriesMap(), projectRootResolver });
    }
    if (mode === "hybrid") {
      return new HybridRetriever({ vectors: this.embeddingStore.entriesMap(), projectRootResolver });
    }
    return new LexicalRetriever({ projectRootResolver });
  }

  private buildWriter(): MemoryWriter {
    return new MemoryWriter(this.adapter, this.paths, {
      appendOnly: this.settings.appendOnly,
      allowDirectWrites: this.settings.allowDirectWrites,
      logger: this.logger.child("writer"),
      inboxLock: this.inboxLock,
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
   * scanConfigChanged — what the index should contain moved (the host should
   * refresh so a new exclusion actually drops notes from the index, and
   * switching image text off actually evicts what OCR already extracted).
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
    const nextScanSettingsKey = scanSettingsKey(settings);
    const scanConfigChanged = nextScanSettingsKey !== this.lastScanSettingsKey;
    this.lastScanSettingsKey = nextScanSettingsKey;

    // Writer options can change without a root change, so always rebuild it.
    this.writer = this.buildWriter();

    if (rootChanged) {
      this.index = this.newIndexManager();
      this.store = new MemoryStore(this.adapter, this.paths, this.logger.child("memory"));
      this.embeddingStore = this.newEmbeddingStore();
      this.extractionCache = this.newExtractionCache();
      // This flag guards a one-shot clear of a cache that may hold sensitive
      // PDF/Office text. It's engine-lifetime state, but the cache instance
      // just changed to point at the new root's Index/extracted.json — reset
      // it so a stale, previously-populated cache at the new root (e.g. an
      // old memoryRoot reused, or a restored folder) still gets the clear
      // cycle if attachment indexing is off there too.
      this.extractionCacheCleared = false;
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
   *
   * Secrets are redacted with the same rule the logger uses. This file lives
   * INSIDE the vault, and a vault is routinely synced, backed up, or committed
   * to git — so writing the server token and embedding API key here in the
   * clear puts them everywhere the vault goes. Nothing reads this file back, so
   * redaction costs the recovery point nothing: it exists to show what the
   * settings WERE, and "there was a token" is the whole of what a reader needs.
   */
  async backupSettings(snapshot: unknown): Promise<void> {
    await this.adapter.write(
      this.paths.settingsBackupFile,
      JSON.stringify(redact(snapshot), null, 2),
    );
  }

  /** Create the base memory folder scaffold. */
  async ensureScaffold(): Promise<void> {
    await this.store.ensureScaffold();
  }

  /** Load a persisted index if present; returns true if one was loaded. */
  async loadIndex(): Promise<boolean> {
    const loaded = (await this.index.load()) !== null;
    // Load the vector cache REGARDLESS of whether the chunk index loaded.
    // Vectors are keyed by chunk id and content hash and gated on provider
    // identity, so they survive a chunk-index rebuild by design — that is the
    // entire point of the content-hash reuse. Loading them only on the success
    // path meant any INDEX_VERSION bump (which forces `load()` to return null)
    // left the store empty, so the rebuild that followed saw every chunk as
    // new and re-embedded the whole vault. On a paid provider that is real
    // money, charged on an upgrade whose chunk text did not change at all.
    await this.embeddingStore.load();
    // Rebuild the retriever whenever vectors are loaded, NOT only when the
    // chunk index also loaded. `entriesMap()` hands out a fresh Map per state
    // change rather than a live reference, so a retriever built before the
    // load stays frozen on an empty vector map forever: after an
    // INDEX_VERSION bump, search silently returned lexical-shaped scores while
    // `getRetrievalMode()` still said "hybrid" and `hasVectors()` still said
    // true. It could not self-heal either — the embed pass only rebuilds when
    // it changed vectors, and on that path every vector is reused.
    this.retriever = this.buildRetriever();
    if (loaded) {
      // A loaded index's eligibility verdicts only stand if the config that
      // produced them is known AND unchanged — an exclusion added while the app
      // was closed would otherwise let an "unchanged" stub speak for a note
      // that should now be gone. The index records that config, so trust it
      // when it matches and fall back to re-reading every note when it does
      // not (or when the index predates the record).
      this.lastScanConfigKey = this.index.getScanConfigKey() ?? "";
    }
    return loaded;
  }

  /** Run an index pass after any in-flight one completes (see indexChain). */
  private serializeIndexPass<T>(op: () => Promise<T>): Promise<T> {
    const run = this.indexChain.then(op, op);
    this.indexChain = run.catch(() => undefined);
    return run;
  }

  /** Full rebuild of the index from the current vault, then persist + embed. */
  reindex(): Promise<{ noteCount: number; chunkCount: number }> {
    return this.serializeIndexPass(() => this.doReindex());
  }

  private async doReindex(): Promise<{ noteCount: number; chunkCount: number }> {
    // Bind to the manager this pass belongs to. `indexChain` serializes passes
    // against each other, but `updateSettings` is synchronous, runs off-chain
    // (a settings blur or its debounce), and on a memory-root change REPLACES
    // this.index with a fresh empty manager. `build`/`refresh` yield to the
    // event loop mid-pass, so re-reading `this.index` after an await could
    // land on that new instance — and `persist()` on an empty manager returns
    // silently, throwing away the whole completed build while still logging
    // success. Holding the reference keeps a pass internally consistent.
    const index = this.index;
    const scanConfig = toScanConfig(this.settings);
    const notes: ScannedNote[] = [
      ...(await this.scanner.scan(scanConfig)),
      ...(await this.scanAttachments(scanConfig)),
    ];
    this.extractionCache.consumeReset(); // a full build re-chunks everything
    const scanKey = JSON.stringify(scanConfig);
    index.setScanConfigKey(scanKey);
    const built = await index.build(notes);
    await index.persist();
    this.logger.info("Reindexed vault", {
      notes: built.metadata.noteCount,
      chunks: built.metadata.chunkCount,
    });
    const result = { noteCount: built.metadata.noteCount, chunkCount: built.metadata.chunkCount };
    // If the engine moved on mid-pass, this result describes the OLD root. It
    // is safely persisted there, but must not set engine-level bookkeeping or
    // drive an embedding pass for a root it did not scan.
    if (this.index !== index) return result;
    this.lastScanConfigKey = scanKey;
    await this.embedIndex();
    return result;
  }

  /** Incremental refresh (used by auto-index and manual refresh). */
  refresh(): Promise<RefreshResult> {
    return this.serializeIndexPass(() => this.doRefresh());
  }

  private async doRefresh(): Promise<RefreshResult> {
    if (!this.index.getIndex()) {
      // Report what the build actually produced. Re-reading `this.index` here
      // is the same hazard the bindings below close: a settings change landing
      // during the bootstrap build swaps in an empty manager, and the caller
      // was then told `added: 0` right after a full index was built.
      const { chunkCount } = await this.doReindex();
      return { added: chunkCount, updated: 0, removed: 0, unchanged: 0 };
    }
    // Bound to one manager for the whole pass — see doReindex for why.
    const index = this.index;
    const scanConfig = toScanConfig(this.settings);
    const scanKey = JSON.stringify(scanConfig);
    // Skip-unchanged scanning keeps a debounced refresh O(changed) in file
    // I/O — but only while the scan config still matches the one the known
    // mtimes were scanned under (see lastScanConfigKey).
    const mdNotes =
      scanKey === this.lastScanConfigKey
        ? await this.scanner.scan(scanConfig, index.getNoteMtimes())
        : await this.scanner.scan(scanConfig);
    // Attachments do their own mtime short-circuit via the extraction cache,
    // so the fast path stays O(changed) for them too.
    const attachmentNotes = await this.scanAttachments(scanConfig);
    const notes = [...mdNotes, ...attachmentNotes];
    index.setScanConfigKey(scanKey);
    // A discarded extraction cache (version bump / corrupt file) means the
    // re-extracted text can differ under an unchanged mtime — force those
    // notes past the index's mtime short-circuit once.
    const force = this.extractionCache.consumeReset()
      ? new Set(attachmentNotes.map((n) => n.path))
      : undefined;
    const result = await index.refresh(notes, force);
    // Persist only when something changed: a no-op persist re-serializes the
    // whole index (tens of MB at scale) on the main thread, and — because the
    // index files live inside the vault — its own writes re-fire the vault
    // watcher and schedule the next debounced refresh, sustaining a
    // refresh/serialize/write cycle with auto-indexing on.
    // Persist when the CONTENT changed, or when the index is holding metadata
    // the file does not have yet (an index written before the mtime map or the
    // scan key existed). Without the second clause an unchanged vault never
    // writes, so the upgrade never lands and every launch re-reads everything.
    if (result.added + result.updated + result.removed > 0 || index.needsMetadataPersist()) {
      await index.persist();
    }
    // See doReindex: a settings change mid-pass means this result describes a
    // root the engine has already left behind.
    if (this.index !== index) return result;
    this.lastScanConfigKey = scanKey;
    // Same economy for the embedding pass: it hashes every chunk to find work,
    // so an all-unchanged refresh under an unchanged backend identity has
    // nothing to embed by construction and skips the sweep.
    if (
      result.added + result.updated + result.removed > 0 ||
      this.lastEmbeddedIdentity !== this.vectorIdentity()
    ) {
      await this.embedIndex();
    }
    return result;
  }

  /**
   * Search the current in-memory index. Async because vector/hybrid modes embed
   * the query first; lexical mode resolves without any network call.
   */
  async search(query: RetrievalQuery): Promise<RetrievalResult[]> {
    const resolved = await this.withQueryVector(query);
    const ranked = this.retriever.retrieve(resolved, this.index.getChunks());
    // The rejection and supersession LEDGERS are never search results.
    //
    // Discarding a proposal copies its content into `rejected-memory.md`, which
    // is indexed like any other note — so the claim the reviewer turned down
    // came back as an ordinary, unlabelled hit, and its structured record even
    // said `pendingReview: false`, asserting it was reviewed memory. That
    // inverts the whole point of the ledger: it exists so an agent stops
    // re-proposing what was refused, not so the refusal becomes searchable
    // knowledge. `find_symbol` already excluded these files for exactly this
    // reason ("the ledgers hold copies of proposal content"); search was simply
    // never brought in line. They stay readable through `list_rejected_memory`,
    // which labels them and carries the reviewer's reason.
    //
    // The PENDING file is deliberately still searchable — an agent seeing its
    // own proposals is a feature — and carries its `[PENDING REVIEW]` label.
    const results = ranked.filter((r) => !this.isLedgerPath(r.chunk.notePath));
    // Retired memory is dropped AFTER ranking, not before: filtering the corpus
    // would change the BM25 corpus statistics every other result is scored
    // against, so retiring one memory would silently re-rank unrelated notes.
    const retired = await this.writer.supersededKeys();
    const live =
      retired.size === 0
        ? results
        : results.filter((r) => !retired.has(supersessionKey(r.chunk.notePath, r.chunk.heading)));
    // Not `dropRetired`: results wrap their chunk, so the key comes from one
    // level deeper. Kept explicit rather than bent into a shared shape.
    // Ageing runs last, on the ranked list: the retriever's scores are
    // comparable within one result set, and weighting the corpus first would
    // move the statistics every score is computed against.
    return applyMemoryDecay(live, this.clock(), this.settings.memoryDecayHalfLifeDays, (p) =>
      this.isMemoryPath(p),
    );
  }

  /**
   * True when a vault path lies under the memory tree.
   *
   * Guarded where the other `isInsideRoot` call sites on an indexed path are
   * not, because this one is on the search path: a chunk whose path somehow
   * fails to normalize should cost that chunk its ageing, not cost the user
   * their whole search. Failing to "not memory" also fails in the harmless
   * direction — the result is returned undecayed rather than hidden.
   */
  private isMemoryPath(notePath: string): boolean {
    try {
      return isInsideRoot(this.paths.memory, notePath);
    } catch {
      return false;
    }
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
  async embedIndex(): Promise<EmbedPassResult> {
    // Serialize passes: chain onto the previous one so two overlapping calls
    // (manual reindex + debounced refresh + settings-triggered sync) can never
    // interleave their snapshot/persist and clobber each other.
    const run = this.embedChain.then(() => this.doEmbedIndex());
    // Swallow on the chain so a failed pass doesn't reject the next one; callers
    // still observe this pass's outcome via the returned promise.
    this.embedChain = run.catch(() => undefined);
    return run;
  }

  private async doEmbedIndex(): Promise<EmbedPassResult> {
    if (!this.embeddingProvider) return { outcome: "no-provider", embedded: 0, reused: 0 };
    const provider = this.embeddingProvider;
    // Bind the index and store this pass belongs to, for the same reason
    // doReindex does: `updateSettings` runs off-chain and replaces both on a
    // root change. Reading `this.index` after the availability await could
    // otherwise pick up a fresh EMPTY manager, embed nothing, and then record
    // the new root's identity as fully embedded — leaving vector search
    // silently stuck on lexical with no later pass willing to retry.
    const index = this.index;
    // Pessimistic until the pass completes: an early return or throw below
    // leaves vectors possibly missing, and null makes the next refresh retry.
    this.lastEmbeddedIdentity = null;
    try {
      if (!(await provider.isAvailable())) {
        this.logger.warn("Embedding provider unavailable; retrieval stays lexical", {
          provider: provider.id,
        });
        return { outcome: "unavailable", embedded: 0, reused: 0, detail: provider.id };
      }
      // Snapshot the ARRAY so a concurrent index swap can't shift it mid-pass,
      // but keep the chunk objects themselves: the store memoizes content
      // hashes by chunk identity, and a fresh wrapper per call would defeat it.
      const chunks = index.getChunks().slice();
      const identity = this.vectorIdentity();
      const store = this.embeddingStore;
      const pass = await store.embedIndex(chunks, provider, {
        batchSize: this.settings.embeddingBatchSize,
        concurrency: this.settings.embeddingConcurrency,
        identity,
      });
      // Only claim this identity as embedded if the engine is still on the
      // root this pass ran against. Otherwise the NEW root would be recorded
      // as up to date on the strength of the old root's work, and no later
      // refresh would re-run the pass for it.
      if (this.index !== index || this.embeddingStore !== store) {
        return { outcome: "superseded", embedded: pass.embedded, reused: pass.reused };
      }
      this.lastEmbeddedIdentity = identity;
      // Rebuild only when the pass changed vectors: the retriever snapshots the
      // vector map at build time, so an unchanged map needs no rebuild — and a
      // rebuild discards the lexical corpus-stats memo. (Vectors loaded from
      // disk are handled by loadIndex, which rebuilds itself.)
      if (pass.embedded > 0 || pass.removed > 0) {
        this.retriever = this.buildRetriever();
      }
      return { outcome: "embedded", embedded: pass.embedded, reused: pass.reused };
    } catch (err) {
      this.logger.warn("Embedding pass failed; retrieval stays lexical", {
        error: toMessage(err),
      });
      return { outcome: "failed", embedded: 0, reused: 0, detail: toMessage(err) };
    }
  }

  /**
   * Called by the host after a settings change: ensure vectors exist for the
   * current provider. A no-op when no provider is configured.
   */
  async syncEmbeddings(): Promise<EmbedPassResult> {
    return this.embedIndex();
  }

  /** The retrieval mode actually serving results (lexical when no provider). */
  getRetrievalMode(): RetrievalMode {
    return this.effectiveMode();
  }

  getIndexStats(): {
    noteCount: number;
    chunkCount: number;
    builtAt: number | null;
    skippedAttachments: number;
    retrievalMode: RetrievalMode;
    vectorsReady: boolean;
  } {
    const idx = this.index.getIndex();
    return {
      noteCount: idx?.metadata.noteCount ?? 0,
      chunkCount: idx?.metadata.chunkCount ?? 0,
      builtAt: idx?.metadata.builtAt ?? null,
      skippedAttachments: this.skippedAttachments,
      // Both, because they can disagree: the mode is "hybrid" the moment a
      // provider is configured, while a vault whose embedding pass has not run
      // (or failed) still answers every query lexically. Reporting only the
      // mode is how 0.11.2's "says hybrid, serves lexical" looked correct.
      retrievalMode: this.effectiveMode(),
      vectorsReady: this.embeddingStore.hasVectors(),
    };
  }

  /** The indexed chunks for a single note, in index order (empty if not indexed). */
  getNoteChunks(notePath: string): IndexedChunk[] {
    const normalized = normalizeVaultRelativePath(notePath);
    return chunksByNote(this.index.getChunks()).get(normalized) ?? [];
  }

  /**
   * Chunks that DECLARE `name`, newest note first.
   *
   * A lookup, not a search: an exact (case-folded) match against the symbols
   * the chunker extracted, so "where is this defined" is answered by the
   * definition rather than by whichever passage mentions it most. Retired
   * sections are dropped here as everywhere else that serves chunk text.
   */
  async findSymbol(name: string, limit: number): Promise<IndexedChunk[]> {
    const want = foldForCompare(name.trim());
    if (want === "") return [];
    const matches = this.index
      .getChunks()
      .filter((c) => c.symbols.some((s) => foldForCompare(s) === want))
      // The Inbox is excluded outright, not labelled as search labels it. This
      // tool answers "where is this defined", and an unreviewed proposal is not
      // a definition — an agent that wrote `function resolveInVault(…)` into
      // `add_memory` would otherwise read its own unreviewed text back as an
      // authoritative declaration. The ledgers hold copies of proposal content
      // for the same reason, so the whole folder goes.
      .filter((c) => !this.isInboxPath(c.notePath));
    return (await this.dropRetired(matches))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  }

  /**
   * True for the two inbox LEDGERS — the rejection and supersession records —
   * and false for the pending file, which is meant to be searchable.
   *
   * Compared canonically, because the caller's path comes from a chunk and
   * these come from the resolved layout. An unparseable path is not a ledger,
   * which leaves it visible: the same fail-visible choice `isInboxPath` makes.
   */
  private isLedgerPath(notePath: string): boolean {
    try {
      const p = normalizeVaultRelativePath(notePath);
      return (
        p === normalizeVaultRelativePath(this.paths.rejectedMemoryFile) ||
        p === normalizeVaultRelativePath(this.paths.supersededMemoryFile)
      );
    } catch {
      return false;
    }
  }

  /** True when a vault path lies in the plugin-managed review folder. Total:
   * an unparseable path is not the inbox, which leaves it visible. */
  private isInboxPath(notePath: string): boolean {
    try {
      return isInsideRoot(this.paths.inbox, notePath);
    } catch {
      return false;
    }
  }

  /** Drop chunks whose section a reviewer retired. Every path that serves chunk
   * text goes through here, so there is one answer to "is this still current". */
  private async dropRetired<T extends { notePath: string; heading: string }>(
    chunks: T[],
  ): Promise<T[]> {
    const retired = await this.writer.supersededKeys();
    if (retired.size === 0) return chunks;
    return chunks.filter((c) => !retired.has(supersessionKey(c.notePath, c.heading)));
  }

  /**
   * A note's chunks with retired sections removed — what may be SERVED to a
   * caller, as opposed to what the index holds.
   *
   * Every path that hands chunk TEXT to someone goes through here. Filtering
   * search and the whole-file context reads alone left this door open: an agent
   * calling `get_note_context` or `summarize_note` on a memory file still saw
   * the superseded text beside its replacement, with nothing to tell them
   * apart — which is the situation superseding exists to end, reached through a
   * third door. {@link getNoteChunks} stays unfiltered because its other
   * callers ask an existence question ("is this note indexed?"), which a
   * retirement does not change.
   */
  async getReadableNoteChunks(notePath: string): Promise<IndexedChunk[]> {
    return this.dropRetired(this.getNoteChunks(notePath));
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
  /**
   * Why a note has no servable passages, or `null` when it has some.
   *
   * Three call sites asked this and each wrote its own answer, so the
   * note-reading tool reported a note whose sections a reviewer RETIRED as "not
   * indexed" — sending an agent to reindex a note that is indexed and
   * deliberately empty of servable content. The distinction belongs here: this
   * is the only layer that knows both what is indexed and what was retired.
   *
   * `servable` is what the CALLER counts as usable, which is not the same
   * question for all three: the reading tools pass their retirement-filtered
   * chunks, while link-graph navigation passes the unfiltered count, because
   * retiring a memory's text does not remove the note from the link graph.
   */
  unservableNote(notePath: string, servable: number, verb: string): string | null {
    if (servable > 0) return null;
    return this.getNoteChunks(notePath).length > 0
      ? `Every section of "${notePath}" has been superseded, so nothing can be ${verb}.`
      : `Note "${notePath}" is not indexed (it may be excluded or outside the vault). ` +
          `Only indexed notes can be ${verb}.`;
  }

  getRelatedNotes(notePath: string): RelatedNotes {
    const normalized = normalizeVaultRelativePath(notePath);
    const refusal = this.unservableNote(normalized, this.getNoteChunks(normalized).length, "navigated");
    if (refusal) throw new ConfigError(refusal);
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
    const chunks = await this.getReadableNoteChunks(normalized);
    const refusal = this.unservableNote(normalized, chunks.length, "summarized");
    if (refusal) throw new ConfigError(refusal);
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

  /**
   * Run several queries and return ONE fused, ranked list.
   *
   * This lives in the engine and not in the MCP handler that calls it, for the
   * same reason `resolveProject` does: it is ranking, not transport. Choosing a
   * candidate depth and combining rankings are retrieval decisions — the
   * hybrid retriever keeps its equivalent constants inside itself, never in a
   * caller — and putting them behind the facade is also what makes a future
   * multi-query UI, or embedding all N queries in a single provider round trip,
   * reachable at all.
   *
   * Sequential rather than concurrent: in vector or hybrid mode each query
   * embeds separately, and fanning five requests at a possibly rate-limited
   * endpoint is not something a single tool call should do on the user's
   * behalf.
   *
   * `sources` on each result lists which query indices found it. Agreement
   * across queries is evidence — a chunk several of them surface ranks above
   * one only a single query found — and that signal does not exist when the
   * questions are asked one at a time.
   */
  async searchBatch(
    queries: string[],
    options: { limit: number; filters: RetrievalQuery["filters"] },
  ): Promise<Array<RetrievalResult & { sources: number[] }>> {
    const { limit, filters } = options;
    // Depth matters more here than for a single search. RRF can only reward
    // agreement it can SEE, so a chunk has to sit inside each query's candidate
    // pool to be credited by it — with a shallow pool the tool quietly degrades
    // toward "whatever the first query ranked highest". Same rule the hybrid
    // retriever uses before its own fusion, and it is nearly free: the
    // retrievers score the whole corpus and then slice, so a deeper pool
    // lengthens a slice rather than adding scoring work.
    const candidates = candidateDepthFor(limit);
    const perQuery: RetrievalResult[][] = [];
    for (const query of queries) {
      // eslint-disable-next-line no-await-in-loop -- deliberate: see above, these must not fan out
      perQuery.push(await this.search({ query, limit: candidates, filters }));
    }
    return fuseByRank(perQuery.map((results) => ({ results, preferPayload: true }))).map(
      (entry) => ({ ...entry.result, score: entry.score, sources: entry.sources }),
    );
  }

  /**
   * Notes the index has seen change since `sinceMs`, newest first.
   *
   * The point is a cheap session warm-start: an agent returning to a vault
   * needs to know what moved since it last looked, and asking that as a search
   * means inventing a query for something that is not a relevance question at
   * all. This reads the note→mtime map the index already holds, so it costs no
   * I/O and no scoring.
   *
   * Excluded notes are absent by construction rather than by a filter here:
   * the map holds only what was indexed, and the scanner's exclusions run
   * before anything reaches the index. There is no path in this method that
   * could surface a note the privacy controls kept out.
   */
  getChangedNotes(
    sinceMs: number,
    limit: number,
  ): { indexed: number; changed: Array<{ path: string; mtime: number }> } {
    // `indexed` comes from the SAME map the results do, so "the index is empty"
    // and "nothing changed in this window" can never disagree. Reading the
    // count from `getIndexStats()` instead would be a second source of truth
    // for one question, and the two are maintained by different code paths.
    const mtimes = this.index.getNoteMtimes();
    const changed: Array<{ path: string; mtime: number }> = [];
    for (const [path, mtime] of mtimes) {
      if (mtime >= sinceMs) changed.push({ path, mtime });
    }
    changed.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    return { indexed: mtimes.size, changed: changed.slice(0, limit) };
  }

  /**
   * Read + parse the review inbox.
   *
   * `project` filters to one project's proposals, folded for case and Unicode
   * form. The rule lives here rather than in the caller because "does this
   * entry belong to project X" is a domain question, and the codebase has been
   * bitten before by the same question being answered twice with different
   * rules — `foldForCompare` exists precisely because a folder was excluded
   * correctly but matched nothing as a search filter, giving zero results
   * indistinguishable from "nothing matched". The review UI calls this with no
   * options and still gets every entry.
   */
  async getPendingMemory(options: { project?: string } = {}): Promise<ParsedInbox> {
    return filterByProject(await this.writer.readInbox(), options.project);
  }

  /** Graduate a reviewed inbox entry into its destination memory file, then
   * drop it from the inbox. Human-in-the-loop; not exposed over the network. */
  async applyPendingMemory(entry: PendingEntry): Promise<ApplyOutcome> {
    return this.writer.applyPending(entry);
  }

  /** Read + parse the supersession ledger (retired memories, newest last). */
  async getSupersessions(): Promise<ParsedInbox> {
    return this.writer.readSupersessions();
  }

  /**
   * Remove a reviewed inbox entry without applying it, recording the rejection
   * so the agent can see the outcome instead of re-proposing it forever.
   * Human-in-the-loop; not exposed over the network.
   */
  async discardPendingMemory(
    entry: PendingEntry,
    opts: { reason?: string } = {},
  ): Promise<{ recorded: boolean }> {
    return this.writer.discardPending(entry, opts);
  }

  /**
   * Read + parse the rejection ledger, optionally narrowed to one project.
   * Same project-matching rule as {@link getPendingMemory} — one answer to
   * "does this entry belong to this project", used by both.
   */
  async getRejectedMemory(options: { project?: string } = {}): Promise<ParsedInbox> {
    return filterByProject(await this.writer.readRejections(), options.project);
  }

  /** Empty the rejection ledger. UI-only: see MemoryWriter.clearRejections. */
  async clearRejectedMemory(): Promise<void> {
    await this.writer.clearRejections();
  }

  /** Propose a memory entry (to the inbox by default; direct write if enabled). */
  async addMemory(
    input: AddMemoryInput,
    opts: { direct?: boolean; subpath?: string; reviewerAuthored?: boolean } = {},
  ): Promise<{
    path: string;
    duplicate: boolean;
    rejection: RejectionMatch | null;
    similarTo?: string;
  }> {
    // Validated here, at the domain boundary, rather than at each caller: a
    // reference that cannot be acted on must never reach the inbox, where a
    // reviewer would approve a replacement that silently retires nothing.
    if (input.supersedes && !parseSupersedesRef(input.supersedes, this.paths.memory)) {
      throw new ValidationError(
        `"supersedes" must be "<path>#<heading>" naming a section of a memory file under ` +
          `${this.paths.memory}. A path outside memory, or a path with no heading, is refused.`,
      );
    }
    const entry: MemoryEntry = {
      type: input.type,
      content: input.content,
      project: input.project,
      source: input.source ?? "Obsidian UI",
      originTool: input.originTool,
      confidence: input.confidence,
      supersedes: input.supersedes,
      // Skipped in two cases. When the proposal already names what it replaces,
      // the agent has said what this covers and a second, weaker signal adds
      // nothing. And on a DIRECT write, because this annotation exists to be
      // read at review time and a direct write has no review — it would bake a
      // "Similar: …" line permanently into a memory file that nobody was given
      // the chance to act on, which is the opposite of reporting.
      similarTo:
        input.supersedes || opts.direct ? undefined : this.similarMemoryRef(input.content),
      tags: input.tags ?? [],
      relatedPaths: input.relatedPaths ?? [],
      timestamp: this.clock(),
    };
    if (opts.direct && opts.subpath) {
      const path = await this.writer.directWrite(opts.subpath, entry);
      return { path, duplicate: false, rejection: null };
    }
    const outcome = await this.writer.proposeToInbox(entry, {
      reviewerAuthored: opts.reviewerAuthored,
    });
    return { ...outcome, similarTo: entry.similarTo };
  }

  /**
   * The existing memory a proposal most overlaps with, if any.
   *
   * Runs inside a write path, so it is offline and total: no query embedding
   * (the retriever degrades to its lexical component without one), and any
   * failure yields "no overlap" rather than failing the proposal. Pending
   * proposals and the ledgers are excluded — a proposal overlapping an
   * unreviewed proposal is not news, and would point `supersedes` at something
   * that is not memory yet.
   */
  private similarMemoryRef(content: string): string | undefined {
    try {
      const candidates = this.retriever
        .retrieve(
          {
            query: content,
            limit: SIMILARITY_CANDIDATES,
            filters: { folder: this.paths.memory },
          },
          this.index.getChunks(),
        )
        .map((r) => r.chunk)
        .filter((c) => !isInsideRoot(this.paths.inbox, c.notePath));
      return findSimilarMemory(content, candidates)?.ref;
    } catch (err) {
      this.logger.warn("Overlap check skipped", { error: toMessage(err) });
      return undefined;
    }
  }

  async createProject(name: string): Promise<string> {
    const project = await this.store.projects.createProject(name);
    return project.folder;
  }

  async listProjects(): Promise<string[]> {
    return this.store.listProjects();
  }

  /**
   * Match a free-form hint — a working-directory path, a repo name, a typed
   * guess — against the projects that actually exist.
   *
   * The agent's side of the world is a filesystem path outside the vault; this
   * side is a folder name a person chose. Nothing connects them, so until now
   * an agent had to guess the project name on every call, and a near miss
   * ("coder-engram" for "Coder Engram") silently returned an empty context that
   * is indistinguishable from a project with nothing in it yet.
   *
   * The hint is treated as TEXT and never as a path: only its last segment is
   * read, nothing is resolved, and no filesystem outside the vault is touched.
   * Matching is over names this vault already exposes through `listProjects`,
   * so this reveals nothing an agent could not already enumerate.
   */
  async resolveProject(hint: string): Promise<{
    exact: string | null;
    ambiguous: string[];
    candidates: string[];
    all: string[];
  }> {
    // Returned so the caller never has to ask again: `listProjects` is a scan
    // of every Markdown file in the vault (~3.5 ms at 20k notes, on the app's
    // main thread), and the miss branch used to repeat it just to say what
    // exists.
    const projects = await this.listProjects();
    // Last path segment, so "/home/u/Git/coder-engram" and a bare repo name
    // reduce to the same thing. Split on both separators: the hint is a string
    // from another machine, whose conventions are not ours to assume.
    const tail = hint.split(/[/\\]/).filter(Boolean).pop() ?? "";
    const needle = projectKey(tail);
    if (needle === "") return { exact: null, ambiguous: [], candidates: [], all: projects };
    // Every key-equal match, not the first. `projectKey` folds separators, so
    // "Acme Client" and "acme-client" collapse to one key — and picking the
    // first would name one with confidence while the other vanished entirely,
    // since the near-match filter below excludes anything key-equal. Silently
    // answering the wrong project is precisely the failure this tool exists to
    // prevent, so an ambiguous hint is reported as ambiguous.
    const matches = projects.filter((p) => projectKey(p) === needle);
    // Substring both ways: a repo "engram" should surface project "Coder
    // Engram", and a repo "coder-engram-plugin" should surface "coder-engram".
    //
    // No `key !== needle` guard, because it cannot fire: a key-equal project is
    // in `matches`, and every branch that renders candidates is one where
    // `matches` is empty. Mutation testing is what showed it was dead — the
    // guard could be deleted with no test noticing, which is the signal that it
    // was protecting nothing.
    const candidates = projects.filter((p) => {
      const key = projectKey(p);
      return key.includes(needle) || needle.includes(key);
    });
    return {
      exact: matches.length === 1 ? matches[0] : null,
      ambiguous: matches.length > 1 ? matches : [],
      candidates,
      all: projects,
    };
  }

  async getProjectContext(name: string): Promise<ContextPart[]> {
    return this.withoutSuperseded(await this.store.getProjectContext(name));
  }

  async getGlobalContext(): Promise<ContextPart[]> {
    return this.withoutSuperseded(await this.store.getGlobalContext());
  }

  /**
   * Replace retired sections in whole-file context reads with a marker.
   *
   * Filtering search alone would leave a superseded memory served through the
   * other door: `get_project_context` returns a file verbatim, so the agent
   * would see the retired text and its replacement side by side with nothing to
   * tell them apart — which is the situation superseding exists to end.
   */
  private async withoutSuperseded(parts: ContextPart[]): Promise<ContextPart[]> {
    const retired = await this.writer.supersededKeys();
    if (retired.size === 0) return parts;
    return parts.map((part) => ({
      ...part,
      content: stripSupersededSections(part.content, part.path, retired).text,
    }));
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

/**
 * Identity of every setting that changes what the index should CONTAIN — the
 * single definition of "what forces a refresh". A change here means the host
 * must refresh, or the setting silently does nothing until something unrelated
 * triggers a scan.
 *
 * Wider than `toScanConfig`, which carries only what the scanner itself needs
 * to judge eligibility. `indexImageText` is the difference: it never reaches
 * the scanner (the OCR extractor reads it directly, reporting no extensions
 * while off), yet turning it off must EVICT the text already extracted from
 * images, and turning it on must extract. Leaving it out left both directions
 * waiting on an unrelated trigger — including the eviction, and OCR text can be
 * as sensitive as a note.
 *
 * Deliberately NOT the same string as the persisted scan-config key: that one
 * gates the skip-unchanged fast path over markdown, which `indexImageText`
 * cannot affect, so adding it there would force a pointless full re-read of
 * every note on the first launch after this change.
 */
function scanSettingsKey(s: EngramSettings): string {
  return JSON.stringify([toScanConfig(s), s.indexImageText]);
}
