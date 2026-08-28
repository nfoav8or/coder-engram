/**
 * SearchModal — query the index and show ranked results with note path,
 * heading and a highlighted snippet. Clicking a result opens the note.
 */

import { App, MarkdownView, Modal, Notice, Setting, TFile } from "obsidian";
import { toMessage } from "../utils/errors";
import { EngramEngine } from "../engine";
import { RetrievalResult } from "../retrieval/retriever";
import { findTermMatches } from "../retrieval/ranking";
import { formatLineRange, formatModifiedDate } from "../utils/format";

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
    this.setTitle("Search memory");

    new Setting(contentEl)
      .setName("Query")
      .addText((text) => {
        text.setPlaceholder("Search indexed notes…");
        text.inputEl.classList.add("engram-full-width");
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

  /** Monotonic search sequence: in vector/hybrid mode a search awaits a network
   * embed, so a slow older query can resolve AFTER a newer one — its results
   * must be dropped, not rendered over the fresh ones. */
  private searchSeq = 0;

  private async runSearch(): Promise<void> {
    const q = this.query.trim();
    this.resultsEl.empty();
    if (q.length === 0) {
      this.resultsEl.createEl("p", { text: "Enter a query.", cls: "engram-stat-row" });
      return;
    }
    const seq = ++this.searchSeq;
    let results: RetrievalResult[] = [];
    try {
      results = await this.engine.search({ query: q, limit: 15 });
    } catch (err) {
      if (seq === this.searchSeq) {
        new Notice(`Search failed: ${toMessage(err)}`);
      }
      return;
    }
    if (seq !== this.searchSeq) return; // a newer search superseded this one
    this.resultsEl.empty(); // clear anything an interleaved run left behind
    if (results.length === 0) {
      // "Nothing is indexed" and "nothing matched" are completely different
      // problems with completely different fixes, and they used to render the
      // same sentence. Nothing indexes automatically on install, so an empty
      // index is the expected state on a first run — the single most likely
      // reason a new user sees no results.
      const indexed = this.engine.getIndexStats().noteCount;
      this.resultsEl.createEl("p", {
        text:
          indexed === 0
            ? "Nothing is indexed yet. Run \"Reindex vault\" from the command palette or the control panel, then search again."
            : `No results for that query (${indexed} notes indexed). Try different terms.`,
        cls: "engram-stat-row",
      });
      return;
    }
    for (const result of results) {
      this.renderResult(result);
    }
  }

  private renderResult(result: RetrievalResult): void {
    const { chunk } = result;
    const el = this.resultsEl.createDiv({ cls: "engram-search-result" });
    el.createDiv({ cls: "engram-result-path", text: chunk.notePath });
    if (chunk.heading) {
      el.createDiv({ cls: "engram-result-heading", text: chunk.heading });
    }
    const modified = formatModifiedDate(chunk.mtime);
    el.createDiv({
      cls: "engram-result-lines",
      text: modified
        ? `${formatLineRange(chunk.startLine, chunk.endLine)} · ${modified}`
        : formatLineRange(chunk.startLine, chunk.endLine),
    });
    const snippetEl = el.createDiv({ cls: "engram-result-snippet" });
    this.renderHighlighted(snippetEl, result.snippet, result.matchedTerms);

    el.addEventListener("click", () => {
      void this.openAtLine(chunk.notePath, chunk.startLine);
      this.close();
    });
  }

  /** Open a note and land the cursor at the retrieved chunk's start line. */
  private async openAtLine(notePath: string, line: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) {
      // Fall back to a plain link open if the path no longer resolves to a file.
      void this.app.workspace.openLinkText(notePath, "", false);
      return;
    }
    try {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file, { eState: { line } });
      if (leaf.view instanceof MarkdownView) {
        leaf.view.editor.setCursor({ line, ch: 0 });
      }
    } catch (err) {
      new Notice(`Could not open note: ${toMessage(err)}`);
    }
  }

  /** Render a snippet with matched terms wrapped in <mark>, without using innerHTML. */
  private renderHighlighted(container: HTMLElement, snippet: string, terms: string[]): void {
    const matches = findTermMatches(snippet, terms);
    if (matches.length === 0) {
      container.setText(snippet);
      return;
    }
    let lastIndex = 0;
    for (const { start, end } of matches) {
      if (start > lastIndex) container.appendText(snippet.slice(lastIndex, start));
      container.createEl("mark", { text: snippet.slice(start, end) });
      lastIndex = end;
    }
    if (lastIndex < snippet.length) container.appendText(snippet.slice(lastIndex));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
