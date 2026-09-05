/**
 * plain-text-extractor — .txt and .csv attachments.
 *
 * These are already text; extraction is just decoding plus a title heading so
 * they enter the pipeline shaped like every other extracted attachment. CSV is
 * indexed as-is — commas tokenize away in retrieval, and preserving the raw
 * rows keeps ranged reads faithful to the file.
 */

import { TextExtractor, attachmentTitle } from "./text-extractor";

/**
 * Pick the decoder by BOM, since a hard-coded "utf-8" mangled UTF-16 files
 * (Notepad's default save encoding on Windows) into mojibake — every other
 * byte decoded as a NUL or control character. `TextDecoder` strips the BOM
 * for all three encodings, so the matched encoding never leaves it behind.
 */
function decodeText(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
  return new TextDecoder("utf-8").decode(data);
}

export class PlainTextExtractor implements TextExtractor {
  readonly extensions = [".txt", ".csv"];

  async extract(path: string, data: ArrayBuffer): Promise<string | null> {
    const text = decodeText(data).trim();
    if (!text) return null;
    return `# ${attachmentTitle(path)}\n\n${text}`;
  }
}
