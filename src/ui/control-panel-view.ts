/**
 * ControlPanelView — a right-sidebar panel showing index stats and quick
 * actions. Decoupled from the plugin via the ControlPanelActions interface so
 * there is no import cycle with main.ts.
 */

import { ItemView, WorkspaceLeaf } from "obsidian";

export const CONTROL_PANEL_VIEW_TYPE = "engram-control-panel";

export interface ControlPanelActions {
  reindex(): Promise<void>;
  openSearch(): void;
  openAddMemory(): void;
  openPendingReview(): void;
  createProject(): void;
  showProjectContext(): void;
  getStats(): {
    noteCount: number;
    chunkCount: number;
    builtAt: number | null;
    skippedAttachments: number;
  };
  getMemoryRoot(): string;
  getServerStatus(): { enabled: boolean; running: boolean; address: string | null };
  restartServer(): Promise<void>;
}

export class ControlPanelView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly actions: ControlPanelActions,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CONTROL_PANEL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Coder Engram";
  }

  getIcon(): string {
    return "brain-circuit";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  /** Public so the plugin can refresh stats after a reindex. */
  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("engram-control-panel");
    root.createEl("h2", { text: "Coder Engram" });

    const stats = this.actions.getStats();
    this.stat(root, "Memory root", this.actions.getMemoryRoot());
    this.stat(root, "Indexed notes", String(stats.noteCount));
    this.stat(root, "Chunks", String(stats.chunkCount));
    this.stat(
      root,
      "Last indexed",
      stats.builtAt ? new Date(stats.builtAt).toLocaleString() : "never",
    );
    // Only shown when it happened: a partial index the user cannot see reads
    // exactly like a document that simply will not match.
    if (stats.skippedAttachments > 0) {
      this.stat(
        root,
        "Attachments skipped",
        `${stats.skippedAttachments} (text budget reached)`,
      );
    }
    const server = this.actions.getServerStatus();
    this.stat(root, "Local server", this.describeServer(server));

    const row = root.createDiv({ cls: "engram-button-row" });
    this.button(row, "Reindex", async () => {
      await this.actions.reindex();
      this.render();
    });
    this.button(row, "Search", () => this.actions.openSearch());
    this.button(row, "Add memory", () => this.actions.openAddMemory());

    const row2 = root.createDiv({ cls: "engram-button-row" });
    this.button(row2, "Review inbox", () => this.actions.openPendingReview());
    this.button(row2, "New project", () => this.actions.createProject());
    this.button(row2, "Project context", () => this.actions.showProjectContext());

    if (server.enabled) {
      const row3 = root.createDiv({ cls: "engram-button-row" });
      this.button(row3, "Restart server", async () => {
        await this.actions.restartServer();
        this.render();
      });
    }
  }

  private describeServer(s: { enabled: boolean; running: boolean; address: string | null }): string {
    if (!s.enabled) return "disabled";
    if (s.running && s.address) return `running · ${s.address}`;
    return "enabled (stopped)";
  }

  private stat(parent: HTMLElement, label: string, value: string): void {
    const row = parent.createDiv({ cls: "engram-stat-row" });
    row.createSpan({ text: label });
    row.createSpan({ text: value, cls: "engram-stat-value" });
  }

  private button(parent: HTMLElement, label: string, onClick: () => void | Promise<void>): void {
    const btn = parent.createEl("button", { text: label });
    btn.addEventListener("click", () => {
      void onClick();
    });
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
