/**
 * Small reusable modals: a single-line prompt and a read-only text display.
 */

import { App, Modal, Setting } from "obsidian";

export class PromptModal extends Modal {
  private value: string;
  private resolved = false;

  constructor(
    app: App,
    private readonly opts: { title: string; placeholder?: string; initial?: string; cta?: string },
    private readonly onSubmit: (value: string | null) => void,
  ) {
    super(app);
    this.value = opts.initial ?? "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.opts.title });

    new Setting(contentEl).addText((t) => {
      t.setPlaceholder(this.opts.placeholder ?? "").setValue(this.value);
      t.onChange((v) => (this.value = v));
      t.inputEl.style.width = "100%";
      t.inputEl.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") {
          evt.preventDefault();
          this.submit();
        }
      });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText(this.opts.cta ?? "OK").setCta().onClick(() => this.submit()),
    );
  }

  private submit(): void {
    this.resolved = true;
    this.onSubmit(this.value.trim() || null);
    this.close();
  }

  onClose(): void {
    if (!this.resolved) this.onSubmit(null);
    this.contentEl.empty();
  }
}

export class TextDisplayModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly body: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });
    const box = contentEl.createDiv({ cls: "engram-pending-entry" });
    if (this.body.trim().length === 0) {
      box.createEl("p", { text: "(empty)", cls: "engram-stat-row" });
    } else {
      box.createEl("pre", { text: this.body });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
