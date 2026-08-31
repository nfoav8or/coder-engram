/**
 * AddMemoryModal — capture a memory entry and route it through the engine
 * (inbox by default). Keeps the user in control: the default action proposes
 * to the review inbox rather than writing into notes.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import { toMessage } from "../utils/errors";
import { EngramEngine } from "../engine";
import { MemoryEntry, MemoryType, Confidence, MEMORY_TYPES } from "../memory/memory-types";

export class AddMemoryModal extends Modal {
  private type: MemoryType = "note";
  private content = "";
  private project = "";
  private tagsText = "";
  private confidence: Confidence | "" = "";

  constructor(
    app: App,
    private readonly engine: EngramEngine,
    private readonly defaults: { project?: string; content?: string; relatedPaths?: string[] } = {},
  ) {
    super(app);
    this.project = defaults.project ?? "";
    this.content = defaults.content ?? "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Add memory");
    contentEl.createEl("p", {
      text: "By default this is proposed to the review inbox for you to apply manually.",
      cls: "engram-stat-row",
    });

    new Setting(contentEl).setName("Type").addDropdown((dd) => {
      for (const t of MEMORY_TYPES) dd.addOption(t, t);
      dd.setValue(this.type).onChange((v) => (this.type = v as MemoryType));
    });

    new Setting(contentEl).setName("Project").addText((t) =>
      t.setPlaceholder("(optional)").setValue(this.project).onChange((v) => (this.project = v)),
    );

    new Setting(contentEl).setName("Tags").setDesc("Comma or newline separated").addText((t) =>
      t.setPlaceholder("decision, architecture").onChange((v) => (this.tagsText = v)),
    );

    new Setting(contentEl).setName("Confidence").addDropdown((dd) => {
      dd.addOption("", "(unspecified)");
      dd.addOption("low", "low");
      dd.addOption("medium", "medium");
      dd.addOption("high", "high");
      dd.onChange((v) => (this.confidence = v as Confidence | ""));
    });

    const contentSetting = new Setting(contentEl).setName("Content");
    contentSetting.controlEl.classList.add("engram-full-width");
    const textarea = contentSetting.controlEl.createEl("textarea", {
      cls: "engram-content-input",
    });
    textarea.classList.add("engram-full-width");
    textarea.rows = 6;
    textarea.value = this.content;
    textarea.addEventListener("input", () => (this.content = textarea.value));

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Propose to inbox")
        .setCta()
        .onClick(() => this.submit()),
    );
  }

  private async submit(): Promise<void> {
    if (this.content.trim().length === 0) {
      new Notice("Memory content is empty.");
      return;
    }
    const tags = this.tagsText
      .split(/[\n,]/)
      .map((s) => s.trim().replace(/^#/, ""))
      .filter(Boolean);
    const entry: Partial<MemoryEntry> = {
      type: this.type,
      content: this.content,
      project: this.project.trim() || undefined,
      tags,
      confidence: this.confidence || undefined,
      relatedPaths: this.defaults.relatedPaths ?? [],
    };
    try {
      const { path, duplicate } = await this.engine.addMemory(
        {
          type: entry.type!,
          content: entry.content!,
          project: entry.project,
          tags: entry.tags,
          confidence: entry.confidence,
          relatedPaths: entry.relatedPaths,
          source: "Obsidian UI",
          originTool: "add-memory-command",
        },
        // Typed by the reviewer, so it overrides an earlier rejection of the
        // same memory rather than being silently dropped by it.
        { reviewerAuthored: true },
      );
      new Notice(duplicate ? `Already pending in ${path}` : `Memory proposed to ${path}`);
      this.close();
    } catch (err) {
      new Notice(`Failed to add memory: ${toMessage(err)}`);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
