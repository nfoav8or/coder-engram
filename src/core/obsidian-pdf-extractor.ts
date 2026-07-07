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
import { TextExtractor, renderPdfMarkdown, joinPdfTextItems } from "../extract/text-extractor";

/** Bound on pages extracted per PDF, so one huge scan can't stall a refresh. */
const MAX_PAGES = 500;

export class ObsidianPdfExtractor implements TextExtractor {
  readonly extensions = [".pdf"];

  async extract(path: string, data: ArrayBuffer): Promise<string | null> {
    let doc: { numPages: number; getPage(n: number): Promise<unknown>; destroy(): Promise<void> } | null =
      null;
    try {
      const pdfjs = await loadPdfJs();
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
      const basename = path.slice(path.lastIndexOf("/") + 1).replace(/\.pdf$/i, "");
      const md = renderPdfMarkdown(basename, pages);
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
