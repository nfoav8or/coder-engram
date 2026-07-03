/**
 * SearchModal — query the index and show ranked results with note path,
 * heading and a highlighted snippet. Clicking a result opens the note.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import { EngramEngine } from "../engine";
import { RetrievalResult } from "../retrieval/retriever";

export class SearchModal extends Modal {
  private query = "";
  private resultsEl!: HTMLElement;

  constructor(
    app: App,
    private readonly engine: EngramEngine,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Search Memory" });

    new Setting(contentEl)
      .setName("Query")
      .addText((text) => {
        text.setPlaceholder("Search indexed notes…");
        text.inputEl.style.width = "100%";
        text.onChange((value) => {
          this.query = value;
        });
        text.inputEl.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter") {
            evt.preventDefault();
            void this.runSearch();
          }
        });
        window.setTimeout(() => text.inputEl.focus(), 0);
      })
      .addButton((btn) =>
        btn.setButtonText("Search").setCta().onClick(() => void this.runSearch()),
      );

    this.resultsEl = contentEl.createDiv({ cls: "engram-search-results" });
    this.resultsEl.createEl("p", {
      text: "Type a query and press Enter.",
      cls: "engram-stat-row",
    });
  }

  private async runSearch(): Promise<void> {
    const q = this.query.trim();
    this.resultsEl.empty();
    if (q.length === 0) {
      this.resultsEl.createEl("p", { text: "Enter a query.", cls: "engram-stat-row" });
      return;
    }
    let results: RetrievalResult[] = [];
    try {
      results = await this.engine.search({ query: q, limit: 15 });
    } catch (err) {
      new Notice(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (results.length === 0) {
      this.resultsEl.createEl("p", {
        text: "No results. Try reindexing the vault, or a different query.",
        cls: "engram-stat-row",
      });
      return;
    }
    for (const result of results) {
      this.renderResult(result);
    }
  }

  private renderResult(result: RetrievalResult): void {
    const el = this.resultsEl.createDiv({ cls: "engram-search-result" });
    el.createDiv({ cls: "engram-result-path", text: result.chunk.notePath });
    if (result.chunk.heading) {
      el.createDiv({ cls: "engram-result-heading", text: result.chunk.heading });
    }
    const snippetEl = el.createDiv({ cls: "engram-result-snippet" });
    this.renderHighlighted(snippetEl, result.snippet, result.matchedTerms);

    el.addEventListener("click", () => {
      this.app.workspace.openLinkText(result.chunk.notePath, "", false);
      this.close();
    });
  }

  /** Render a snippet with matched terms wrapped in <mark>, without using innerHTML. */
  private renderHighlighted(container: HTMLElement, snippet: string, terms: string[]): void {
    if (terms.length === 0) {
      container.setText(snippet);
      return;
    }
    const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "ig");
    let lastIndex = 0;
    for (const match of snippet.matchAll(pattern)) {
      const idx = match.index ?? 0;
      if (idx > lastIndex) container.appendText(snippet.slice(lastIndex, idx));
      container.createEl("mark", { text: match[0] });
      lastIndex = idx + match[0].length;
    }
    if (lastIndex < snippet.length) container.appendText(snippet.slice(lastIndex));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
