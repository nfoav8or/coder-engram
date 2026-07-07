/**
 * plain-text-extractor — .txt and .csv attachments.
 *
 * These are already text; extraction is just decoding plus a title heading so
 * they enter the pipeline shaped like every other extracted attachment. CSV is
 * indexed as-is — commas tokenize away in retrieval, and preserving the raw
 * rows keeps ranged reads faithful to the file.
 */

import { TextExtractor, attachmentTitle } from "./text-extractor";

export class PlainTextExtractor implements TextExtractor {
  readonly extensions = [".txt", ".csv"];

  async extract(path: string, data: ArrayBuffer): Promise<string | null> {
    const text = new TextDecoder("utf-8").decode(data).trim();
    if (!text) return null;
    return `# ${attachmentTitle(path)}\n\n${text}`;
  }
}
