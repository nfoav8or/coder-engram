/**
 * PendingMemoryModal — richer per-entry review of the pending-memory inbox (M4).
 *
 * Each proposed entry is shown as a card with its destination and controls to
 * Apply (graduate it into the matching memory file and drop it from the inbox),
 * Edit & apply (tweak the content first), or Discard. "Open inbox file" remains
 * as an escape hatch for manual editing. Apply/discard route through the engine
 * → MemoryWriter, so every write stays inside the memory root.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import { EngramEngine } from "../engine";
import { PendingEntry, resolveApplyDestination } from "../memory/pending-inbox";
import { toMessage } from "../utils/errors";
import { PromptModal } from "./simple-modals";

export class PendingMemoryModal extends Modal {
  /** Guards against overlapping apply/discard while a mutation is in flight
   * (defense-in-depth above the writer's own inbox serialization). */
  private busy = false;

  constructor(
    app: App,
    private readonly engine: EngramEngine,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    await this.renderList();
  }

  private async renderList(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Review pending memory");

    const pendingPath = this.engine.getPaths().pendingMemoryFile;

    let entries: PendingEntry[] = [];
    try {
      entries = (await this.engine.getPendingMemory()).entries;
    } catch (err) {
      new Notice(`Could not read inbox: ${toMessage(err)}`);
      return;
    }

    if (entries.length === 0) {
      contentEl.createEl("p", {
        text: "The inbox is empty — no pending memory to review.",
        cls: "engram-stat-row",
      });
      this.renderFooter(pendingPath);
      return;
    }

    contentEl.createEl("p", {
      text: `${entries.length} pending ${entries.length === 1 ? "entry" : "entries"}.`,
      cls: "engram-stat-row",
    });
    for (const entry of entries) this.renderEntry(contentEl, entry);
    this.renderFooter(pendingPath);
  }

  private renderEntry(parent: HTMLElement, entry: PendingEntry): void {
    const card = parent.createDiv({ cls: "engram-pending-entry" });

    const titleParts = [entry.type];
    if (entry.project) titleParts.push(`· ${entry.project}`);
    titleParts.push(`· ${entry.timestampLabel}`);
    card.createEl("h3", { text: titleParts.join(" ") });

    let destination = "(unknown)";
    try {
      destination = resolveApplyDestination(entry, this.engine.getPaths());
    } catch {
      // A malformed project name can't be routed; Apply will surface the error.
    }
    card.createEl("p", { text: `Applies to: ${destination}`, cls: "engram-result-path" });

    card.createEl("pre", { text: entry.content || "(no content)" });

    if (entry.tags.length > 0) {
      card.createEl("p", {
        text: `Tags: ${entry.tags.map((t) => `#${t}`).join(" ")}`,
        cls: "engram-stat-row",
      });
    }
    if (entry.relatedPaths.length > 0) {
      card.createEl("p", {
        text: `Related: ${entry.relatedPaths.join(", ")}`,
        cls: "engram-stat-row",
      });
    }

    const row = card.createDiv({ cls: "engram-button-row" });
    this.button(row, "Apply", () => this.apply(entry));
    this.button(row, "Edit & apply", () => this.editAndApply(entry));
    this.button(row, "Discard", () => this.discard(entry), { warning: true });
  }

  private async apply(entry: PendingEntry): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const { destination } = await this.engine.applyPendingMemory(entry);
      new Notice(`Applied to ${destination}.`);
    } catch (err) {
      new Notice(`Apply failed: ${toMessage(err)}`);
    } finally {
      this.busy = false;
    }
    await this.renderList();
  }

  private editAndApply(entry: PendingEntry): void {
    new EditContentModal(this.app, entry.content, (edited) => {
      // `null` now means cancelled, and only that.
      if (edited === null) return;
      if (edited.trim() === "") {
        new Notice("Memory content is empty — nothing applied.");
        return;
      }
      // Keep the original `raw` so removal still matches; only the applied block
      // uses the edited content.
      void this.apply({ ...entry, content: edited });
    }).open();
  }

  /**
   * Ask for a reason first. The prompt doubles as the confirmation step this
   * irreversible button never had — cancelling it cancels the discard — and the
   * reason is what the agent reads back, so "wrong project" stops it repeating
   * the mistake where a bare removal taught it nothing.
   */
  private discard(entry: PendingEntry): void {
    if (this.busy) return;
    new PromptModal(
      this.app,
      {
        title: "Discard proposal",
        placeholder: "Why? (optional — the agent sees this)",
        cta: "Discard",
      },
      (reason) => {
        if (reason === null) return;
        void this.doDiscard(entry, reason);
      },
    ).open();
  }

  private async doDiscard(entry: PendingEntry, reason: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const { recorded } = await this.engine.discardPendingMemory(entry, { reason });
      new Notice(
        recorded
          ? "Entry discarded and recorded as rejected."
          : "Entry discarded, but the rejection could not be recorded.",
      );
    } catch (err) {
      new Notice(`Discard failed: ${toMessage(err)}`);
    } finally {
      this.busy = false;
    }
    await this.renderList();
  }

  private renderFooter(pendingPath: string): void {
    const actions = this.contentEl.createDiv({ cls: "engram-button-row" });
    this.button(actions, "Open inbox file", () => {
      void this.app.workspace.openLinkText(pendingPath, "", false);
      this.close();
    });
    this.button(actions, "Open rejected", () => {
      void this.app.workspace.openLinkText(this.engine.getPaths().rejectedMemoryFile, "", false);
      this.close();
    });
    this.button(actions, "Clear rejections", () => this.clearRejections(), { warning: true });
    this.button(actions, "Refresh", () => this.renderList());
  }

  /** Forget every recorded rejection, so those memories can be proposed again. */
  private async clearRejections(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const { entries } = await this.engine.getRejectedMemory();
      await this.engine.clearRejectedMemory();
      new Notice(
        entries.length === 0
          ? "No rejections were recorded."
          : `Cleared ${entries.length} rejection(s); those memories can be proposed again.`,
      );
    } catch (err) {
      new Notice(`Could not clear rejections: ${toMessage(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private button(
    parent: HTMLElement,
    label: string,
    onClick: () => void | Promise<void>,
    opts: { warning?: boolean } = {},
  ): void {
    const btn = parent.createEl("button", { text: label });
    // Discard permanently removes a proposal and there is no undo. Three
    // identically-styled buttons in a row made a mis-click indistinguishable
    // from an intentional one; Obsidian's own warning styling is the standard
    // way to mark the destructive member of a group.
    if (opts.warning) btn.classList.add("mod-warning");
    btn.addEventListener("click", () => void onClick());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** A multi-line content editor used by "Edit & apply". */
class EditContentModal extends Modal {
  private value: string;
  private resolved = false;

  constructor(
    app: App,
    initial: string,
    private readonly onSubmit: (value: string | null) => void,
  ) {
    super(app);
    this.value = initial;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Edit memory content");

    new Setting(contentEl).addTextArea((t) => {
      t.setValue(this.value).onChange((v) => (this.value = v));
      t.inputEl.classList.add("engram-full-width");
      t.inputEl.rows = 10;
      window.setTimeout(() => t.inputEl.focus(), 0);
    });

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Apply").setCta().onClick(() => this.submit()),
      )
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }

  private submit(): void {
    // Pass the trimmed value even when it is empty. Collapsing "" to null here
    // made "cleared the box and clicked Apply" indistinguishable from
    // "cancelled", so the caller silently did nothing; null now means
    // cancelled and nothing else.
    this.resolved = true;
    this.onSubmit(this.value.trim());
    this.close();
  }

  onClose(): void {
    if (!this.resolved) this.onSubmit(null);
    this.contentEl.empty();
  }
}
