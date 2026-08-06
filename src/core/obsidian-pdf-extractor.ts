/**
 * obsidian-pdf-extractor — PDF text extraction via Obsidian's BUNDLED pdf.js,
 * exposed to plugins through the official `loadPdfJs()` API. Zero bundle cost
 * and fully local: the PDF's bytes never leave the machine.
 *
 * This is the third adapter file allowed to import `obsidian` (with
 * ObsidianVaultAdapter and ObsidianHttpClient); everything reusable lives in
 * the pure `extract/` module.
 *
 * Extraction quality is upstream pdf.js quality: born-digital PDFs extract
 * well; scanned/image-only PDFs yield no text and are skipped (null).
 */

import { loadPdfJs } from "obsidian";
import { TextExtractor, attachmentTitle, renderPdfMarkdown, joinPdfTextItems } from "../extract/text-extractor";

/** Bound on pages extracted per PDF, so one huge scan can't stall a refresh. */
const MAX_PAGES = 500;

/**
 * Wall-clock bound on one document.
 *
 * The page cap bounds how much we ASK for; it does not bound how long pdf.js
 * takes to answer. A malformed file that makes the parser spin does not throw,
 * so the `catch` below never runs — the await simply never settles, and the
 * refresh that is waiting on it never finishes. `ObsidianHttpClient` races
 * `requestUrl` against a timer for exactly this reason; attachments are
 * untrusted bytes, so the same guard belongs here.
 *
 * 60 s is far past any real document (a 500-page PDF extracts in seconds) and
 * far short of a user noticing a wedged refresh.
 */
const EXTRACT_TIMEOUT_MS = 60_000;

/**
 * Reject if `work` has not settled within the timeout. The underlying work is
 * abandoned rather than cancelled — pdf.js offers no cancellation — so this
 * bounds the WAIT, not the worker.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`PDF extraction timed out after ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ObsidianPdfExtractor implements TextExtractor {
  readonly extensions = [".pdf"];

  async extract(path: string, data: ArrayBuffer): Promise<string | null> {
    return withTimeout(this.extractPages(path, data), EXTRACT_TIMEOUT_MS, path).catch(() => null);
  }

  /**
   * Returns null for a PDF with no extractable text, and for a corrupt,
   * encrypted, or unparseable one — the caller skips the attachment either way.
   * A timeout surfaces as a rejection that `extract` turns into the same null:
   * a file that wedges the parser is treated exactly like one that fails it.
   */
  private async extractPages(path: string, data: ArrayBuffer): Promise<string | null> {
    let doc: { numPages: number; getPage(n: number): Promise<unknown>; destroy(): Promise<void> } | null =
      null;
    try {
      // `loadPdfJs()` is typed `any`, so name the shape we actually use rather
      // than letting that spread through the extraction path.
      const pdfjs = (await loadPdfJs()) as {
        getDocument(src: { data: ArrayBuffer }): { promise: Promise<typeof doc> };
      };
      doc = await pdfjs.getDocument({ data }).promise;
      if (!doc) return null;
      const pageCount = Math.min(doc.numPages, MAX_PAGES);
      const pages: string[] = [];
      for (let p = 1; p <= pageCount; p++) {
        const page = (await doc.getPage(p)) as {
          getTextContent(): Promise<{ items: Array<{ str: string; hasEOL?: boolean }> }>;
        };
        const content = await page.getTextContent();
        pages.push(joinPdfTextItems(content.items));
      }
      const md = renderPdfMarkdown(attachmentTitle(path), pages);
      // The truncation note must never COUNT as text: an image-only PDF over
      // the page cap still has no extractable content and stays null.
      if (md === null) return null;
      return doc.numPages > MAX_PAGES
        ? `${md}\n\n(extraction stopped at page ${MAX_PAGES} of ${doc.numPages})`
        : md;
    } catch {
      // Corrupt/encrypted/unparseable: skip the attachment, never throw.
      return null;
    } finally {
      await doc?.destroy().catch(() => {});
    }
  }
}
