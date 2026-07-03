/**
 * PendingMemoryModal — review the pending-memory inbox. Shows the current
 * inbox contents and offers to open the file for manual editing/applying.
 * (M1 is deliberately review-by-hand; richer per-entry apply/discard is M3.)
 */

import { App, Modal, Notice } from "obsidian";
import { EngramEngine } from "../engine";

export class PendingMemoryModal extends Modal {
  constructor(
    app: App,
    private readonly engine: EngramEngine,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Review Pending Memory" });

    const pendingPath = this.engine.getPaths().pendingMemoryFile;
    contentEl.createEl("p", { text: pendingPath, cls: "engram-result-path" });

    const file = this.app.vault.getAbstractFileByPath(pendingPath);
    if (!file) {
      contentEl.createEl("p", {
        text: "The inbox is empty — no pending memory has been proposed yet.",
        cls: "engram-stat-row",
      });
      return;
    }

    let content = "";
    try {
      content = await this.app.vault.adapter.read(pendingPath);
    } catch (err) {
      new Notice(`Could not read inbox: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const box = contentEl.createDiv({ cls: "engram-pending-entry" });
    box.createEl("pre", { text: content });

    const actions = contentEl.createDiv({ cls: "engram-button-row" });
    const openBtn = actions.createEl("button", { text: "Open inbox file" });
    openBtn.addEventListener("click", () => {
      this.app.workspace.openLinkText(pendingPath, "", false);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
