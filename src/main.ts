/**
 * Coder Engram — plugin entrypoint.
 *
 * Wires Obsidian (commands, views, settings, file events) to the
 * Obsidian-agnostic EngramEngine. The plugin implements SettingsHost and
 * ControlPanelActions so the settings tab and control panel stay decoupled.
 */

import { Notice, Plugin, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { EngramEngine } from "./engine";
import { isPluginArtifact } from "./memory/memory-types";
import { ObsidianVaultAdapter } from "./core/obsidian-vault-adapter";
import { ObsidianHttpClient } from "./core/obsidian-http-client";
import { ObsidianPdfExtractor } from "./core/obsidian-pdf-extractor";
import { ObsidianOcrExtractor } from "./core/obsidian-ocr-extractor";
import { CanvasExtractor } from "./extract/canvas-extractor";
import { OfficeExtractor } from "./extract/office-extractor";
import { PlainTextExtractor } from "./extract/plain-text-extractor";
import { RtfExtractor } from "./extract/rtf-extractor";
import {
  DEFAULT_SETTINGS,
  EngramSettings,
  migrateSettings,
} from "./settings/settings";
import { EngramSettingTab, SettingsHost } from "./settings/settings-tab";
import {
  ControlPanelActions,
  ControlPanelView,
  CONTROL_PANEL_VIEW_TYPE,
} from "./ui/control-panel-view";
import { SearchModal } from "./ui/search-modal";
import { AddMemoryModal } from "./ui/add-memory-modal";
import { PendingMemoryModal } from "./ui/pending-memory-modal";
import { PromptModal, TextDisplayModal } from "./ui/simple-modals";
import { LocalServer } from "./server/local-server";
import { createLogger, Logger } from "./utils/logger";
import { debounce, Debounced } from "./utils/debounce";
import { toMessage } from "./utils/errors";

const AUTO_INDEX_DEBOUNCE_MS = 2500;

export default class EngramPlugin
  extends Plugin
  implements SettingsHost, ControlPanelActions
{
  settings: EngramSettings = { ...DEFAULT_SETTINGS };
  private logger!: Logger;
  private engine!: EngramEngine;
  private server!: LocalServer;
  private debouncedRefresh!: Debounced<[]>;
  private debouncedConfigRefresh!: Debounced<[]>;
  /** Last announced server state (`up:<host>:<port>` / `down` / "" = unknown),
   * so per-edit settings commits don't repeat the same Notice. */
  private lastServerState = "";
  /** In-flight guard: a double-clicked Reindex must not run two full scans. */
  private reindexing = false;

  async onload(): Promise<void> {
    this.settings = migrateSettings(await this.loadData());
    this.logger = createLogger(() => this.settings.debugLogging, "engram");
    const adapter = new ObsidianVaultAdapter(this.app);
    this.engine = new EngramEngine(adapter, this.settings, this.logger, undefined, {
      http: new ObsidianHttpClient(),
      extractors: [
        new ObsidianPdfExtractor(),
        new OfficeExtractor(),
        new RtfExtractor(),
        new PlainTextExtractor(),
        new CanvasExtractor(),
        new ObsidianOcrExtractor(this.app, () => this.settings.indexImageText),
      ],
    });
    this.server = new LocalServer({
      engine: this.engine,
      logger: this.logger.child("server"),
      serverInfo: { name: this.manifest.id, version: this.manifest.version },
    });

    this.debouncedRefresh = debounce(() => {
      void this.autoRefresh();
    }, AUTO_INDEX_DEBOUNCE_MS);
    this.debouncedConfigRefresh = debounce(() => {
      void this.configRefresh();
    }, AUTO_INDEX_DEBOUNCE_MS);

    this.registerView(
      CONTROL_PANEL_VIEW_TYPE,
      (leaf) => new ControlPanelView(leaf, this),
    );

    this.addSettingTab(new EngramSettingTab(this.app, this));
    this.addRibbonIcon("brain-circuit", "Coder Engram: Control Panel", () => {
      void this.activateControlPanel();
    });

    this.registerCommands();
    this.registerFileWatchers();

    // Load an existing index in the background; don't block plugin load.
    this.app.workspace.onLayoutReady(() => {
      void this.engine.loadIndex().then((loaded) => {
        if (loaded) this.refreshControlPanel();
      });
      // Start the local server only if the user has explicitly enabled it.
      void this.syncServer();
    });

    this.logger.info("Plugin loaded", { memoryRoot: this.settings.memoryRoot });
  }

  onunload(): void {
    this.debouncedRefresh?.cancel();
    this.debouncedConfigRefresh?.cancel();
    void this.server?.stop();
  }

  // --- SettingsHost ---

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async onSettingsChanged(): Promise<void> {
    const { rootChanged, embeddingChanged, scanConfigChanged } =
      this.engine.updateSettings(this.settings);
    // Only the memory-root move resets the index; reload it from the new
    // location so search/stats aren't left empty.
    if (rootChanged) await this.engine.loadIndex();
    // Best-effort settings backup into Config/; never let it block a save.
    try {
      await this.engine.backupSettings(this.settings);
    } catch (err) {
      this.logger.warn("Settings backup failed", { error: toMessage(err) });
    }
    // Apply server enable/disable/config changes (start, stop, or restart).
    await this.syncServer();

    // If the embedding provider/model/endpoint/key/mode changed, (re)embed the
    // current index in the background so switching to a vector provider takes
    // effect without a manual reindex. The engine owns the "what forces a
    // re-embed" definition, so this can't drift from what it rebuilds.
    if (embeddingChanged) void this.syncEmbeddings();

    // If the eligibility rules changed (excluded folders/tags/patterns,
    // included folders), refresh so newly-excluded notes actually leave the
    // index. Skipped on a root change — that path already reloads/reindexes.
    // Debounced: the settings tab fires per edit.
    if (!rootChanged && scanConfigChanged) this.debouncedConfigRefresh();

    this.refreshControlPanel();
  }

  /**
   * Re-embed the index against the current provider (background, best-effort).
   * A no-op when the provider is "none". Surfaces a Notice for vector providers
   * so the user knows retrieval mode may have changed.
   */
  private async syncEmbeddings(): Promise<void> {
    if (this.settings.embeddingProvider === "none") return;
    try {
      new Notice("Coder Engram: updating embeddings…");
      const pass = await this.engine.syncEmbeddings();
      this.refreshControlPanel();
      // Report what actually happened. Every failure in an embedding pass is
      // non-fatal by design (retrieval degrades to lexical), which meant they
      // all used to arrive here indistinguishable from success — so a user
      // whose Ollama simply was not running was told "Embeddings updated" and
      // had no way to learn otherwise short of opening devtools.
      switch (pass.outcome) {
        case "unavailable":
          new Notice(
            `Embedding provider "${pass.detail}" is not reachable — search stays lexical. ` +
              "Check that it is running and that the endpoint and model are right in settings.",
          );
          break;
        case "failed":
          new Notice(`Embedding pass failed — search stays lexical. ${pass.detail ?? ""}`.trim());
          break;
        case "no-provider":
        case "superseded":
          break; // nothing the user needs to act on
        default:
          new Notice(
            `Embeddings updated (${pass.embedded} new, ${pass.reused} reused). ` +
              `Retrieval mode: ${this.engine.getRetrievalMode()}.`,
          );
      }
    } catch (err) {
      this.logger.warn("Embedding sync failed", { error: toMessage(err) });
      new Notice(`Embedding sync failed — search stays lexical. ${toMessage(err)}`);
    }
  }

  /**
   * Reconcile the running server with the current settings: start it when
   * enabled, stop it when disabled, and restart it to pick up host/port/token
   * changes. Failures surface as a Notice and never throw into a settings save.
   */
  private async syncServer(): Promise<void> {
    try {
      if (this.settings.server.enabled) {
        const addr = await this.server.start(this.settings);
        // start() is a no-op when the server config is unchanged; only a real
        // state transition deserves a Notice (the settings tab commits per
        // edit, and a Notice per edit is noise).
        const state = `up:${addr.host}:${addr.port}`;
        if (state !== this.lastServerState) {
          this.lastServerState = state;
          new Notice(`Coder Engram server listening on ${addr.host}:${addr.port}.`);
        }
      } else if (this.server.isRunning()) {
        await this.server.stop();
        this.lastServerState = "down";
        new Notice("Coder Engram server stopped.");
      }
    } catch (err) {
      // A bad config (e.g. non-localhost without opt-in, port in use) must not
      // leave a half-open listener; ensure it is stopped and tell the user.
      await this.server.stop().catch(() => {});
      new Notice(`Server not started: ${toMessage(err)}`);
      this.logger.error("Server sync failed", { error: toMessage(err) });
      // Unknown state after a failure: re-announce whatever happens next.
      this.lastServerState = "";
    }
  }

  async rebuildIndex(): Promise<void> {
    // Shares the reindex in-flight guard: "Rebuild now" double-clicked (or
    // racing the Reindex command) must not run two concurrent full scans.
    if (this.reindexing) {
      throw new Error("A reindex is already in progress.");
    }
    this.reindexing = true;
    try {
      await this.engine.reindex();
    } finally {
      this.reindexing = false;
    }
    this.refreshControlPanel();
  }

  // --- ControlPanelActions ---

  async reindex(): Promise<void> {
    if (!this.settings.indexingEnabled) {
      new Notice("Indexing is disabled in settings.");
      return;
    }
    if (this.reindexing) {
      new Notice("Reindex already in progress.");
      return;
    }
    this.reindexing = true;
    new Notice("Coder Engram: reindexing…");
    try {
      const { noteCount, chunkCount } = await this.engine.reindex();
      new Notice(`Indexed ${noteCount} notes (${chunkCount} chunks).`);
    } catch (err) {
      new Notice(`Reindex failed: ${toMessage(err)}`);
      this.logger.error("Reindex failed", { error: toMessage(err) });
    } finally {
      this.reindexing = false;
    }
    this.refreshControlPanel();
  }

  openSearch(): void {
    new SearchModal(this.app, this.engine).open();
  }

  openAddMemory(): void {
    new AddMemoryModal(this.app, this.engine, {
      project: this.settings.defaultProject || undefined,
    }).open();
  }

  openPendingReview(): void {
    new PendingMemoryModal(this.app, this.engine).open();
  }

  createProject(): void {
    new PromptModal(
      this.app,
      { title: "Create project memory folder", placeholder: "Project name", cta: "Create" },
      (name) => {
        if (!name) return;
        void this.doCreateProject(name);
      },
    ).open();
  }

  showProjectContext(): void {
    const project = this.settings.defaultProject;
    if (!project) {
      new Notice("Set a default project in settings first.");
      return;
    }
    void this.engine
      .getProjectContext(project)
      .then((parts) => {
        const text = parts.map((p) => `${p.path}:\n${p.content}`).join("\n\n---\n\n");
        new TextDisplayModal(this.app, `Project context: ${project}`, text).open();
      })
      .catch((err) => new Notice(`Could not load project context: ${toMessage(err)}`));
  }

  getStats(): {
    noteCount: number;
    chunkCount: number;
    builtAt: number | null;
    skippedAttachments: number;
  } {
    return this.engine.getIndexStats();
  }

  getMemoryRoot(): string {
    return this.settings.memoryRoot;
  }

  getServerStatus(): { enabled: boolean; running: boolean; address: string | null } {
    const addr = this.server?.getAddress() ?? null;
    return {
      enabled: this.settings.server.enabled,
      running: this.server?.isRunning() ?? false,
      address: addr ? `${addr.host}:${addr.port}` : null,
    };
  }

  async restartServer(): Promise<void> {
    // A REAL restart, bypassing start()'s unchanged-config skip: this command
    // is the user's recovery lever for a wedged server, so it must rebind.
    await this.server.stop();
    this.lastServerState = "";
    await this.syncServer();
  }

  // --- internals ---

  private async doCreateProject(name: string): Promise<void> {
    try {
      await this.engine.ensureScaffold();
      const folder = await this.engine.createProject(name);
      new Notice(`Created project memory at ${folder}`);
    } catch (err) {
      new Notice(`Could not create project: ${toMessage(err)}`);
    }
  }

  private async autoRefresh(): Promise<void> {
    if (!this.settings.indexingEnabled || !this.settings.autoIndexOnChange) return;
    try {
      await this.engine.refresh();
      this.refreshControlPanel();
    } catch (err) {
      this.logger.warn("Auto-refresh failed", { error: toMessage(err) });
    }
  }

  /**
   * One-shot refresh after the scan config changed. NOT gated on
   * autoIndexOnChange (that governs continuous file-event indexing): a new
   * exclusion must drop the excluded notes from the index even for users who
   * never enabled auto-indexing — otherwise they stay searchable until a
   * manual reindex or an unrelated vault event.
   */
  private async configRefresh(): Promise<void> {
    if (!this.settings.indexingEnabled) return;
    try {
      await this.engine.refresh();
      this.refreshControlPanel();
    } catch (err) {
      this.logger.warn("Config-change refresh failed", { error: toMessage(err) });
    }
  }

  private registerCommands(): void {
    this.addCommand({
      id: "open-control-panel",
      name: "Open control panel",
      callback: () => void this.activateControlPanel(),
    });
    this.addCommand({
      id: "reindex-vault",
      name: "Reindex vault",
      callback: () => void this.reindex(),
    });
    this.addCommand({
      id: "search-memory",
      name: "Search memory",
      callback: () => this.openSearch(),
    });
    this.addCommand({
      id: "add-memory",
      name: "Add memory",
      callback: () => this.openAddMemory(),
    });
    this.addCommand({
      id: "add-current-note-to-project",
      name: "Add current note to project memory",
      callback: () => this.addCurrentNoteToProject(),
    });
    this.addCommand({
      id: "create-project",
      name: "Create project memory folder",
      callback: () => this.createProject(),
    });
    this.addCommand({
      id: "show-project-context",
      name: "Show project context",
      callback: () => this.showProjectContext(),
    });
    this.addCommand({
      id: "review-pending-memory",
      name: "Review pending memory",
      callback: () => this.openPendingReview(),
    });
    this.addCommand({
      id: "summarize-current-note",
      name: "Summarize current note",
      callback: () => this.summarizeCurrentNote(),
    });
    this.addCommand({
      id: "start-session-note",
      name: "Start session note",
      callback: () => this.startSessionNote(),
    });
    this.addCommand({
      id: "end-session-note",
      name: "End session note",
      callback: () => this.endSessionNote(),
    });
    this.addCommand({
      id: "restart-server",
      name: "Restart local server",
      callback: () => void this.restartServer(),
    });
  }

  private registerFileWatchers(): void {
    // Ignore the plugin's own Index/ and Config/ writes: every refresh persists
    // there, and reacting to our own events would schedule the next refresh
    // indefinitely. Paths are re-read per event so a memory-root move applies.
    const trigger = (file: TAbstractFile) => {
      if (isPluginArtifact(this.engine.getPaths(), file.path)) return;
      this.debouncedRefresh();
    };
    // A rename is suppressed only when BOTH ends are artifacts: a note renamed
    // into Index/ still needs a refresh to drop its chunks under the old path.
    const renameTrigger = (file: TAbstractFile, oldPath: string) => {
      const paths = this.engine.getPaths();
      if (isPluginArtifact(paths, file.path) && isPluginArtifact(paths, oldPath)) return;
      this.debouncedRefresh();
    };
    this.registerEvent(this.app.vault.on("modify", trigger));
    this.registerEvent(this.app.vault.on("create", trigger));
    this.registerEvent(this.app.vault.on("delete", trigger));
    this.registerEvent(this.app.vault.on("rename", renameTrigger));
  }

  private addCurrentNoteToProject(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note.");
      return;
    }
    new AddMemoryModal(this.app, this.engine, {
      project: this.settings.defaultProject || undefined,
      content: `Note: [[${file.basename}]]`,
      relatedPaths: [file.path],
    }).open();
  }

  private summarizeCurrentNote(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note to summarize.");
      return;
    }
    new Notice("Coder Engram: summarizing…");
    void this.engine
      .summarizeNote(file.path)
      .then((summary) => {
        const heading = `Summary of ${file.basename} · ${summary.method} · ` +
          `${summary.sentences.length}/${summary.totalUnits} sentences`;
        const body = summary.sentences.length
          ? summary.sentences.map((s) => `• ${s}`).join("\n\n")
          : "No summarizable content found.";
        new TextDisplayModal(this.app, heading, body).open();
      })
      .catch((err) => new Notice(`Could not summarize: ${toMessage(err)}`));
  }

  private startSessionNote(): void {
    const project = this.settings.defaultProject;
    if (!project) {
      new Notice("Set a default project in settings first.");
      return;
    }
    const stamp = formatSessionStamp(Date.now());
    void this.engine.startSession(project, stamp).then((path) => {
      new Notice(`Session note: ${path}`);
      void this.app.workspace.openLinkText(path, "", true);
    }).catch((err) => new Notice(`Could not start session: ${toMessage(err)}`));
  }

  private endSessionNote(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file || !file.path.includes("/sessions/")) {
      new Notice("Open a session note first (in a project's sessions folder).");
      return;
    }
    new PromptModal(
      this.app,
      { title: "End session note", placeholder: "Closing summary", cta: "Append" },
      (summary) => {
        if (!summary) return;
        void this.engine
          .endSession(file.path, summary)
          .then(() => new Notice("Session closed."))
          .catch((err) => new Notice(`Could not close session: ${toMessage(err)}`));
      },
    ).open();
  }

  private async activateControlPanel(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(CONTROL_PANEL_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: CONTROL_PANEL_VIEW_TYPE, active: true });
    }
    // `revealLeaf` returns a promise (since Obsidian 1.7.2, well below the
    // 1.13.0 floor); leaving it unawaited would drop any rejection on the floor.
    if (leaf) await workspace.revealLeaf(leaf);
  }

  private refreshControlPanel(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CONTROL_PANEL_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof ControlPanelView) view.render();
    }
  }
}

/** Format a ms timestamp as "YYYY-MM-DD-HHMM" for session filenames. */
export function formatSessionStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
