/**
 * Claude Code Engram — plugin entrypoint.
 *
 * Wires Obsidian (commands, views, settings, file events) to the
 * Obsidian-agnostic EngramEngine. The plugin implements SettingsHost and
 * ControlPanelActions so the settings tab and control panel stay decoupled.
 */

import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { EngramEngine } from "./engine";
import { ObsidianVaultAdapter } from "./core/obsidian-vault-adapter";
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

  async onload(): Promise<void> {
    this.settings = migrateSettings(await this.loadData());
    this.logger = createLogger(() => this.settings.debugLogging, "engram");
    const adapter = new ObsidianVaultAdapter(this.app);
    this.engine = new EngramEngine(adapter, this.settings, this.logger);
    this.server = new LocalServer({
      engine: this.engine,
      logger: this.logger.child("server"),
      serverInfo: { name: this.manifest.id, version: this.manifest.version },
    });

    this.debouncedRefresh = debounce(() => {
      void this.autoRefresh();
    }, AUTO_INDEX_DEBOUNCE_MS);

    this.registerView(
      CONTROL_PANEL_VIEW_TYPE,
      (leaf) => new ControlPanelView(leaf, this),
    );

    this.addSettingTab(new EngramSettingTab(this.app, this));
    this.addRibbonIcon("brain-circuit", "Claude Code Engram: Control Panel", () => {
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
    void this.server?.stop();
  }

  // --- SettingsHost ---

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async onSettingsChanged(): Promise<void> {
    const rootChanged = this.engine.updateSettings(this.settings);
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
    this.refreshControlPanel();
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
        new Notice(`Claude Code Engram server listening on ${addr.host}:${addr.port}.`);
      } else if (this.server.isRunning()) {
        await this.server.stop();
        new Notice("Claude Code Engram server stopped.");
      }
    } catch (err) {
      // A bad config (e.g. non-localhost without opt-in, port in use) must not
      // leave a half-open listener; ensure it is stopped and tell the user.
      await this.server.stop().catch(() => {});
      new Notice(`Server not started: ${toMessage(err)}`);
      this.logger.error("Server sync failed", { error: toMessage(err) });
    }
  }

  async rebuildIndex(): Promise<void> {
    await this.engine.reindex();
    this.refreshControlPanel();
  }

  // --- ControlPanelActions ---

  async reindex(): Promise<void> {
    if (!this.settings.indexingEnabled) {
      new Notice("Indexing is disabled in settings.");
      return;
    }
    new Notice("Claude Code Engram: reindexing…");
    try {
      const { noteCount, chunkCount } = await this.engine.reindex();
      new Notice(`Indexed ${noteCount} notes (${chunkCount} chunks).`);
    } catch (err) {
      new Notice(`Reindex failed: ${toMessage(err)}`);
      this.logger.error("Reindex failed", { error: toMessage(err) });
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
      { title: "Create Project Memory Folder", placeholder: "Project name", cta: "Create" },
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
    void this.engine.getProjectContext(project).then((ctx) => {
      new TextDisplayModal(this.app, `Project context: ${project}`, ctx).open();
    });
  }

  getStats(): { noteCount: number; chunkCount: number; builtAt: number | null } {
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

  private registerCommands(): void {
    this.addCommand({
      id: "open-control-panel",
      name: "Open Control Panel",
      callback: () => void this.activateControlPanel(),
    });
    this.addCommand({
      id: "reindex-vault",
      name: "Reindex Vault",
      callback: () => void this.reindex(),
    });
    this.addCommand({
      id: "search-memory",
      name: "Search Memory",
      callback: () => this.openSearch(),
    });
    this.addCommand({
      id: "add-memory",
      name: "Add Memory",
      callback: () => this.openAddMemory(),
    });
    this.addCommand({
      id: "add-current-note-to-project",
      name: "Add Current Note to Project Memory",
      callback: () => this.addCurrentNoteToProject(),
    });
    this.addCommand({
      id: "create-project",
      name: "Create Project Memory Folder",
      callback: () => this.createProject(),
    });
    this.addCommand({
      id: "show-project-context",
      name: "Show Project Context",
      callback: () => this.showProjectContext(),
    });
    this.addCommand({
      id: "review-pending-memory",
      name: "Review Pending Memory",
      callback: () => this.openPendingReview(),
    });
    this.addCommand({
      id: "start-session-note",
      name: "Start Session Note",
      callback: () => this.startSessionNote(),
    });
    this.addCommand({
      id: "end-session-note",
      name: "End Session Note",
      callback: () => this.endSessionNote(),
    });
    this.addCommand({
      id: "restart-server",
      name: "Restart Local Server",
      callback: () => void this.restartServer(),
    });
  }

  private registerFileWatchers(): void {
    const trigger = () => this.debouncedRefresh();
    this.registerEvent(this.app.vault.on("modify", trigger));
    this.registerEvent(this.app.vault.on("create", trigger));
    this.registerEvent(this.app.vault.on("delete", trigger));
    this.registerEvent(this.app.vault.on("rename", trigger));
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
      { title: "End Session Note", placeholder: "Closing summary", cta: "Append" },
      (summary) => {
        if (!summary) return;
        void this.engine.endSession(file.path, summary).then(() => {
          new Notice("Session closed.");
        });
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
    if (leaf) workspace.revealLeaf(leaf);
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
