/**
 * extract — the attachment-to-text boundary.
 *
 * Extractors turn a binary attachment into markdown-ish text that flows into
 * the SAME pipeline as a note: the scanner emits it as a ScannedNote, so
 * chunking, incremental refresh, exclusions, retrieval, and every MCP tool
 * work unchanged. Like `EmbeddingProvider` and `HttpClient`, the interface is
 * pure and the host injects implementations (the production PDF extractor
 * lives in the UI layer because it uses Obsidian's bundled pdf.js).
 *
 * Extraction is LOCAL-ONLY in v1 (Obsidian's own pdf.js); nothing leaves the
 * machine. Indexing attachments is gated by the off-by-default
 * `indexAttachments` setting.
 */

/** One extractor for one family of file extensions. */
export interface TextExtractor {
  /** Lowercased dot-extensions this extractor handles, e.g. [".pdf"]. */
  readonly extensions: string[];
  /**
   * Extract markdown-ish text from the file's bytes. Returns null when the
   * file yields no text (scanned/image-only PDF, corrupt file) — the caller
   * then skips the attachment rather than indexing an empty document.
   * Implementations must never throw for bad input; return null instead.
   */
  extract(path: string, data: ArrayBuffer): Promise<string | null>;
}

/**
 * Render extracted PDF page texts as markdown with one `## Page N` section per
 * page. The page headings give the chunker real sections, so search results
 * and note reads carry a "Page N" breadcrumb and outline mode becomes a page
 * map. Pure and unit-testable; the Obsidian-side extractor supplies the raw
 * per-page strings.
 */
export function renderPdfMarkdown(title: string, pages: string[]): string | null {
  const parts: string[] = [`# ${title}`];
  let hasText = false;
  for (let i = 0; i < pages.length; i++) {
    const text = pages[i].trim();
    if (text.length === 0) continue;
    hasText = true;
    parts.push(`## Page ${i + 1}\n\n${text}`);
  }
  return hasText ? parts.join("\n\n") : null;
}

/**
 * Join pdf.js text items into a page string. Items arrive in reading order
 * with `hasEOL` marking line breaks; blank lines between text blocks become
 * paragraph breaks, which the chunker windows on.
 */
export function joinPdfTextItems(items: Array<{ str: string; hasEOL?: boolean }>): string {
  let out = "";
  for (const item of items) {
    out += item.str;
    if (item.hasEOL) out += "\n";
  }
  // Collapse 3+ newlines to paragraph breaks and trim trailing spaces per line.
  return out
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}
