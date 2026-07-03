/**
 * EngramEngine — the orchestration facade shared by the UI commands and (from
 * M2) the local server. It owns the index, retriever, memory store and writer,
 * and rebuilds them whenever settings change. Keeping this Obsidian-agnostic
 * (it only needs a VaultAdapter) means the server can reuse it verbatim.
 */

import { VaultAdapter } from "./core/vault-adapter";
import { HttpClient } from "./core/http-client";
import { VaultScanner } from "./indexing/vault-scanner";
import { IndexManager, RefreshResult } from "./indexing/index-manager";
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
import { MemoryStore, SessionNote } from "./memory/memory-store";
import { MemoryWriter } from "./memory/memory-writer";
import {
  EngramSettings,
  RetrievalMode,
  toScanConfig,
  toMemoryLayout,
  toEmbeddingConfig,
} from "./settings/settings";
import { normalizeVaultRelativePath, isInsideRoot } from "./utils/paths";
import { ConfigError } from "./utils/errors";
import { Logger } from "./utils/logger";

/** Optional injected dependencies (production wires the Obsidian HTTP client). */
export interface EngramEngineDeps {
  http?: HttpClient;
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
  private readonly http?: HttpClient;
  /** Serializes embedding passes so overlapping reindex/refresh/sync can't
   * interleave (last-writer-wins persist / mid-pass index mutation). */
  private embedChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: VaultAdapter,
    settings: EngramSettings,
    private readonly logger: Logger,
    private readonly clock: () => number = () => Date.now(),
    deps: EngramEngineDeps = {},
  ) {
    this.settings = settings;
    this.http = deps.http;
    this.paths = EngramEngine.resolvePaths(settings);
    this.scanner = new VaultScanner(adapter, logger.child("scanner"));
    // Path-dependent components (built by wire()).
    this.index = this.newIndexManager();
    this.store = new MemoryStore(adapter, this.paths, logger.child("memory"));
    this.writer = this.buildWriter();
    this.embeddingStore = this.newEmbeddingStore();
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
   * @returns true if the memory root changed (index was reset).
   */
  updateSettings(settings: EngramSettings): boolean {
    const previousRoot = this.paths.root;
    const previousEmbeddingKey = embeddingKey(this.settings);
    this.settings = settings;
    this.paths = EngramEngine.resolvePaths(settings);
    const rootChanged = this.paths.root !== previousRoot;
    const embeddingChanged = embeddingKey(settings) !== previousEmbeddingKey;

    // Writer options can change without a root change, so always rebuild it.
    this.writer = this.buildWriter();

    if (rootChanged) {
      this.index = this.newIndexManager();
      this.store = new MemoryStore(this.adapter, this.paths, this.logger.child("memory"));
      this.embeddingStore = this.newEmbeddingStore();
      this.embeddingProvider = this.buildProvider();
      this.retriever = this.buildRetriever();
    } else if (embeddingChanged) {
      // Provider/model/endpoint/key/mode changed: rebuild the provider and
      // retriever in place. Existing vectors are kept; the host should call
      // syncEmbeddings() to (re)embed against the (possibly new) provider.
      this.embeddingProvider = this.buildProvider();
      this.retriever = this.buildRetriever();
    }
    return rootChanged;
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
      // Bring the vector cache back into memory and rebuild the retriever so a
      // reloaded index can serve vector/hybrid results immediately.
      await this.embeddingStore.load();
      this.retriever = this.buildRetriever();
    }
    return loaded;
  }

  /** Full rebuild of the index from the current vault, then persist + embed. */
  async reindex(): Promise<{ noteCount: number; chunkCount: number }> {
    const notes = await this.scanner.scan(toScanConfig(this.settings));
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
    const notes = await this.scanner.scan(toScanConfig(this.settings));
    const result = this.index.refresh(notes);
    await this.index.persist();
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
        error: err instanceof Error ? err.message : String(err),
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
      await this.embeddingStore.embedIndex(chunks, provider, {
        batchSize: this.settings.embeddingBatchSize,
        identity: this.vectorIdentity(),
      });
      this.retriever = this.buildRetriever();
    } catch (err) {
      this.logger.warn("Embedding pass failed; retrieval stays lexical", {
        error: err instanceof Error ? err.message : String(err),
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

  /** Propose a memory entry (to the inbox by default; direct write if enabled). */
  async addMemory(input: AddMemoryInput, opts: { direct?: boolean; subpath?: string } = {}): Promise<string> {
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
      return this.writer.directWrite(opts.subpath, entry);
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

  async getProjectContext(name: string): Promise<string> {
    return this.store.getProjectContext(name);
  }

  async getGlobalContext(): Promise<string> {
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
 * Identity of the embedding-related settings. When this string changes, the
 * provider and/or retriever must be rebuilt.
 */
function embeddingKey(s: EngramSettings): string {
  return [
    s.embeddingProvider,
    s.embeddingModel,
    s.embeddingEndpoint,
    s.embeddingApiKey,
    s.retrievalMode,
  ].join(" ");
}
