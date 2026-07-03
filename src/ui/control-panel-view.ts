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
  getStats(): { noteCount: number; chunkCount: number; builtAt: number | null };
  getMemoryRoot(): string;
  isServerEnabled(): boolean;
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
    return "Claude Code Engram";
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
    root.createEl("h2", { text: "Claude Code Engram" });

    const stats = this.actions.getStats();
    this.stat(root, "Memory root", this.actions.getMemoryRoot());
    this.stat(root, "Indexed notes", String(stats.noteCount));
    this.stat(root, "Chunks", String(stats.chunkCount));
    this.stat(
      root,
      "Last indexed",
      stats.builtAt ? new Date(stats.builtAt).toLocaleString() : "never",
    );
    this.stat(root, "Local server", this.actions.isServerEnabled() ? "enabled" : "disabled");

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
