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

import { App, TAbstractFile, TFile } from "obsidian";
import { TextExtractor, attachmentTitle } from "../extract/text-extractor";
import { withTimeout } from "../utils/timeout";

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

/**
 * Wall-clock bound on one image.
 *
 * `extractText` is another plugin's code, and on first use it downloads its
 * language data — so this call can be slow for reasons that have nothing to do
 * with the image. Slow is fine; NEVER SETTLING is not: a hung call throws
 * nothing for the `catch` below to see, and the refresh waiting on it never
 * finishes (the same failure mode bounded in the PDF extractor and in
 * `ObsidianHttpClient`).
 *
 * Five minutes is generous on purpose. It is far past OCR of any real image
 * (seconds) and past a first-use language download on a poor connection, so a
 * timeout here means genuinely stuck rather than merely slow — which matters
 * because the result is cached by mtime, so a false timeout would leave the
 * image unindexed until it is edited.
 */
const EXTRACT_TIMEOUT_MS = 300_000;

/**
 * Narrow a vault entry to a file.
 *
 * Structural rather than `instanceof TFile`, and deliberately a type predicate
 * rather than a cast: `obsidian` ships types only, so naming `TFile` in a value
 * position would turn an erased type-import into a runtime one and break the
 * Node-environment unit tests, which stand in for the vault. A folder has no
 * `stat`, which is the only distinction this needs.
 */
function isFile(entry: TAbstractFile | null): entry is TFile {
  return entry !== null && "stat" in entry;
}

export class ObsidianOcrExtractor implements TextExtractor {
  /**
   * Empty while the setting is off, so the scanner never even lists image
   * files — the engine re-reads this each scan, so toggling the setting takes
   * effect on the next refresh without rebuilding the engine.
   */
  get extensions(): string[] {
    return this.isEnabled() ? IMAGE_EXTENSIONS : [];
  }

  /** Works from the vault path; the caller must not read the image for us. */
  readonly needsBytes = false as const;

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
      if (!isFile(file)) return null;
      const text = (await withTimeout(api.extractText(file), EXTRACT_TIMEOUT_MS, path))?.trim();
      if (!text) return null;
      return `# ${attachmentTitle(path)}\n\n${text}`;
    } catch {
      // A companion plugin's failure must never break a refresh.
      return null;
    }
  }
}
