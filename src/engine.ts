/**
 * EngramEngine — the orchestration facade shared by the UI commands and (from
 * M2) the local server. It owns the index, retriever, memory store and writer,
 * and rebuilds them whenever settings change. Keeping this Obsidian-agnostic
 * (it only needs a VaultAdapter) means the server can reuse it verbatim.
 */

import { VaultAdapter } from "./core/vault-adapter";
import { VaultScanner } from "./indexing/vault-scanner";
import { IndexManager, RefreshResult } from "./indexing/index-manager";
import { LexicalRetriever } from "./retrieval/lexical-retriever";
import { RetrievalQuery, RetrievalResult } from "./retrieval/retriever";
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
  toScanConfig,
  toMemoryLayout,
} from "./settings/settings";
import { normalizeVaultRelativePath, isInsideRoot } from "./utils/paths";
import { ConfigError } from "./utils/errors";
import { Logger } from "./utils/logger";

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
  private retriever: LexicalRetriever;

  constructor(
    private readonly adapter: VaultAdapter,
    settings: EngramSettings,
    private readonly logger: Logger,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.settings = settings;
    this.paths = EngramEngine.resolvePaths(settings);
    this.scanner = new VaultScanner(adapter, logger.child("scanner"));
    // Path-dependent components (built by wire()).
    this.index = this.newIndexManager();
    this.store = new MemoryStore(adapter, this.paths, logger.child("memory"));
    this.writer = this.buildWriter();
    this.retriever = this.newRetriever();
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

  private newRetriever(): LexicalRetriever {
    return new LexicalRetriever({
      projectRootResolver: (p) => resolveProjectPaths(this.paths, p).folder,
    });
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
    this.settings = settings;
    this.paths = EngramEngine.resolvePaths(settings);
    const rootChanged = this.paths.root !== previousRoot;

    // Writer options can change without a root change, so always rebuild it.
    this.writer = this.buildWriter();

    if (rootChanged) {
      this.index = this.newIndexManager();
      this.store = new MemoryStore(this.adapter, this.paths, this.logger.child("memory"));
      this.retriever = this.newRetriever();
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
    return (await this.index.load()) !== null;
  }

  /** Full rebuild of the index from the current vault, then persist. */
  async reindex(): Promise<{ noteCount: number; chunkCount: number }> {
    const notes = await this.scanner.scan(toScanConfig(this.settings));
    const built = this.index.build(notes);
    await this.index.persist();
    this.logger.info("Reindexed vault", {
      notes: built.metadata.noteCount,
      chunks: built.metadata.chunkCount,
    });
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
    return result;
  }

  /** Search the current in-memory index. */
  search(query: RetrievalQuery): RetrievalResult[] {
    return this.retriever.retrieve(query, this.index.getChunks());
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
