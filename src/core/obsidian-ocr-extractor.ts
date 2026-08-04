/**
 * obsidian-ocr-extractor — text in images, via the Text Extractor companion
 * plugin when the user has it installed.
 *
 * WHY NOT OUR OWN OCR ENGINE. Running OCR in-process means Tesseract compiled
 * to WebAssembly, and that is not viable here on three counts:
 *
 *   1. Obsidian's developer policy forbids a plugin from installing or updating
 *      its own dependencies. Tesseract fetches a `.traineddata` language file
 *      per language on first use, which is exactly that.
 *   2. The engine plus one language is measured in megabytes; this plugin's
 *      whole bundle is ~120 KB, and every other extractor here is
 *      dependency-free by design.
 *   3. It would put a network fetch behind a feature users reasonably read as
 *      local, breaking the promise that attachment bytes never leave the
 *      machine.
 *
 * So this delegates instead. Text Extractor already solves OCR, publishes a
 * documented API for exactly this kind of reuse, and keeps its own cache. When
 * it is absent we simply extract nothing — images stay unindexed, as before.
 *
 * NOTE ON NETWORK: Text Extractor downloads its language data on first use.
 * That is its behaviour, not ours, but this feature triggers it — which is why
 * it sits behind its own opt-in setting and is disclosed in the settings UI and
 * docs/SECURITY.md rather than folded into general attachment indexing.
 */

import { App, TFile } from "obsidian";
import { TextExtractor, attachmentTitle } from "../extract/text-extractor";

/** The slice of Text Extractor's published API this uses. */
interface TextExtractorApi {
  extractText(file: TFile): Promise<string>;
  canFileBeExtracted(filePath: string): boolean;
}

/**
 * Images Text Extractor can read. Kept narrow on purpose: an extension listed
 * here that it cannot handle costs a wasted round trip per file per refresh.
 */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".bmp"];

export class ObsidianOcrExtractor implements TextExtractor {
  /**
   * Empty while the setting is off, so the scanner never even lists image
   * files — the engine re-reads this each scan, so toggling the setting takes
   * effect on the next refresh without rebuilding the engine.
   */
  get extensions(): string[] {
    return this.isEnabled() ? IMAGE_EXTENSIONS : [];
  }

  constructor(
    private readonly app: App,
    private readonly isEnabled: () => boolean,
  ) {}

  /** Text Extractor's API object, or null when the plugin isn't installed/enabled. */
  private api(): TextExtractorApi | null {
    const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, { api?: unknown }> } })
      .plugins?.plugins;
    const api = plugins?.["text-extractor"]?.api as TextExtractorApi | undefined;
    return api && typeof api.extractText === "function" ? api : null;
  }

  /**
   * The bytes are already read by the caller but are not needed: Text Extractor
   * works from the vault file and owns its own cache, so handing it the path
   * avoids a second copy of the image in memory.
   */
  async extract(path: string): Promise<string | null> {
    if (!this.isEnabled()) return null;
    const api = this.api();
    if (!api) return null;
    try {
      if (typeof api.canFileBeExtracted === "function" && !api.canFileBeExtracted(path)) return null;
      const file = this.app.vault.getAbstractFileByPath(path);
      // Duck-typed rather than `instanceof TFile`: a folder has no `stat`.
      if (!file || !("stat" in file)) return null;
      const text = (await api.extractText(file as TFile))?.trim();
      if (!text) return null;
      return `# ${attachmentTitle(path)}\n\n${text}`;
    } catch {
      // A companion plugin's failure must never break a refresh.
      return null;
    }
  }
}
