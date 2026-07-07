/**
 * office-extractor — text extraction for Microsoft Office (OOXML) and
 * LibreOffice (OpenDocument) files, with zero dependencies.
 *
 * Both families are ZIP archives of machine-generated XML:
 *   docx → word/document.xml           (w:p paragraphs of w:t runs)
 *   pptx → ppt/slides/slideN.xml       (a:t runs per slide)
 *   xlsx → xl/sharedStrings.xml        (t runs; the workbook's string cells)
 *   odt/odp/ods → content.xml          (text:p / text:h; draw:page per slide;
 *                                       table:table per sheet)
 *
 * Extraction walks the XML with indexOf-based scanning — deliberately NOT
 * regexes over the whole document: lazy-quantifier block patterns degrade
 * quadratically on crafted unclosed-tag input (measured: minutes on 2 MB),
 * while these walkers stay linear on anything. Attachments are untrusted
 * bytes; malformed structure must cost O(n), never a frozen renderer.
 * Numeric spreadsheet cells are not extracted — string content is what
 * retrieval can usefully match.
 */

import { TextExtractor, attachmentTitle } from "./text-extractor";
import { readZipDirectory, readZipEntry, readZipText } from "./zip";

/** Decode the five XML entities plus numeric character references. */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

interface XmlBlock {
  /** Raw attribute text of the opening tag. */
  attrs: string;
  /** Raw inner XML between the opening and closing tag. */
  inner: string;
}

/** True when `c` legitimately ends a tag NAME (so "<w:p" doesn't match "<w:pPr"). */
function endsTagName(c: string): boolean {
  return c === ">" || c === " " || c === "\t" || c === "\n" || c === "\r" || c === "/";
}

/**
 * Linear scan for non-nested `<tag ...>...</tag>` blocks. Unclosed or
 * malformed structure terminates the scan instead of backtracking.
 */
export function xmlBlocks(xml: string, tag: string): XmlBlock[] {
  const openTok = `<${tag}`;
  const closeTok = `</${tag}>`;
  const out: XmlBlock[] = [];
  let i = 0;
  for (;;) {
    const start = xml.indexOf(openTok, i);
    if (start === -1) break;
    if (!endsTagName(xml.charAt(start + openTok.length))) {
      i = start + openTok.length;
      continue;
    }
    const tagEnd = xml.indexOf(">", start);
    if (tagEnd === -1) break;
    if (xml.charAt(tagEnd - 1) === "/") {
      i = tagEnd + 1; // self-closing: no inner content
      continue;
    }
    const end = xml.indexOf(closeTok, tagEnd);
    if (end === -1) break;
    out.push({ attrs: xml.slice(start + openTok.length, tagEnd), inner: xml.slice(tagEnd + 1, end) });
    i = end + closeTok.length;
  }
  return out;
}

/** Decoded text of `<tag>` runs whose content is pure text (no child markup). */
function textRuns(xml: string, tag: string): string[] {
  return xmlBlocks(xml, tag)
    .map((b) => b.inner)
    .filter((t) => t.length > 0 && !t.includes("<"))
    .map(decodeXmlEntities);
}

/** Mixed-content text: strip child tags, then decode (block-bounded input). */
function flattenText(inner: string): string {
  return decodeXmlEntities(inner.replace(/<[^>]*>/g, "")).trim();
}

/** Values of `attr="..."` on self-closing/opening `<tag ...>` tags, linearly. */
function tagAttrValues(xml: string, tag: string, attr: string): string[] {
  const openTok = `<${tag}`;
  const needle = `${attr}="`;
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const start = xml.indexOf(openTok, i);
    if (start === -1) break;
    if (!endsTagName(xml.charAt(start + openTok.length))) {
      i = start + openTok.length;
      continue;
    }
    const tagEnd = xml.indexOf(">", start);
    if (tagEnd === -1) break;
    const attrs = xml.slice(start + openTok.length, tagEnd);
    const at = attrs.indexOf(needle);
    if (at !== -1) {
      const valEnd = attrs.indexOf('"', at + needle.length);
      if (valEnd !== -1) out.push(decodeXmlEntities(attrs.slice(at + needle.length, valEnd)));
    }
    i = tagEnd + 1;
  }
  return out;
}

function assemble(title: string, sections: string[]): string | null {
  const body = sections.filter(Boolean);
  if (body.length === 0) return null;
  return [`# ${title}`, ...body].join("\n\n");
}

// --- per-format extraction ---------------------------------------------------

async function extractDocx(title: string, data: Uint8Array): Promise<string | null> {
  const xml = await readZipText(data, "word/document.xml");
  if (!xml) return null;
  const paras: string[] = [];
  for (const p of xmlBlocks(xml, "w:p")) {
    const text = textRuns(p.inner, "w:t").join("").trim();
    if (!text) continue;
    const heading = /w:val="Heading(\d)"/.exec(p.inner.slice(0, 500));
    paras.push(heading ? `${"#".repeat(Math.min(6, Number(heading[1]) + 1))} ${text}` : text);
  }
  return assemble(title, paras);
}

async function extractPptx(title: string, data: Uint8Array): Promise<string | null> {
  const slides = readZipDirectory(data)
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => Number(/\d+/.exec(a.name)![0]) - Number(/\d+/.exec(b.name)![0]));
  const sections: string[] = [];
  for (let i = 0; i < slides.length; i++) {
    const xml = new TextDecoder("utf-8").decode(await readZipEntry(data, slides[i]));
    const text = xmlBlocks(xml, "a:p")
      .map((p) => textRuns(p.inner, "a:t").join("").trim())
      .filter(Boolean)
      .join("\n");
    if (text) sections.push(`## Slide ${i + 1}\n\n${text}`);
  }
  return assemble(title, sections);
}

async function extractXlsx(title: string, data: Uint8Array): Promise<string | null> {
  const shared = await readZipText(data, "xl/sharedStrings.xml");
  const workbook = await readZipText(data, "xl/workbook.xml");
  const sections: string[] = [];
  if (workbook) {
    const names = tagAttrValues(workbook, "sheet", "name");
    if (names.length) sections.push(`Sheets: ${names.join(" · ")}`);
  }
  if (shared) {
    const items = xmlBlocks(shared, "si")
      .map((b) => textRuns(b.inner, "t").join("").trim())
      .filter(Boolean);
    if (items.length) sections.push(items.join("\n"));
  }
  return assemble(title, sections);
}

async function extractOpenDocument(
  title: string,
  data: Uint8Array,
  kind: "odt" | "odp" | "ods",
): Promise<string | null> {
  const xml = await readZipText(data, "content.xml");
  if (!xml) return null;
  const sections: string[] = [];

  if (kind === "odp") {
    xmlBlocks(xml, "draw:page").forEach((page, i) => {
      // Mixed content is common ("See <text:span>bold</text:span> now"), so
      // flatten each paragraph rather than keeping only pure runs.
      const text = xmlBlocks(page.inner, "text:p").map((p) => flattenText(p.inner)).filter(Boolean).join("\n");
      if (text) sections.push(`## Slide ${i + 1}\n\n${text}`);
    });
  } else if (kind === "ods") {
    for (const table of xmlBlocks(xml, "table:table")) {
      const nameAt = table.attrs.indexOf('table:name="');
      const name =
        nameAt !== -1
          ? decodeXmlEntities(table.attrs.slice(nameAt + 12, table.attrs.indexOf('"', nameAt + 12)))
          : "Sheet";
      const cells = xmlBlocks(table.inner, "text:p").map((p) => flattenText(p.inner)).filter(Boolean);
      if (cells.length) sections.push(`## ${name}\n\n${cells.join("\n")}`);
    }
  } else {
    // odt: headings + paragraphs in document order — walk both tags linearly,
    // taking whichever occurs next.
    let i = 0;
    for (;;) {
      const h = xml.indexOf("<text:h", i);
      const p = xml.indexOf("<text:p", i);
      if (h === -1 && p === -1) break;
      const isHeading = h !== -1 && (p === -1 || h < p);
      const start = isHeading ? h : p;
      const tok = isHeading ? "text:h" : "text:p";
      if (!endsTagName(xml.charAt(start + tok.length + 1))) {
        i = start + tok.length + 1;
        continue;
      }
      const tagEnd = xml.indexOf(">", start);
      if (tagEnd === -1) break;
      if (xml.charAt(tagEnd - 1) === "/") {
        i = tagEnd + 1;
        continue;
      }
      const end = xml.indexOf(`</${tok}>`, tagEnd);
      if (end === -1) break;
      const attrs = xml.slice(start + tok.length + 1, tagEnd);
      const text = flattenText(xml.slice(tagEnd + 1, end));
      i = end + tok.length + 3;
      if (!text) continue;
      if (isHeading) {
        const level = /text:outline-level="(\d)"/.exec(attrs);
        sections.push(`${"#".repeat(Math.min(6, level ? Number(level[1]) + 1 : 2))} ${text}`);
      } else {
        sections.push(text);
      }
    }
  }
  return assemble(title, sections);
}

// --- the extractor -----------------------------------------------------------

export class OfficeExtractor implements TextExtractor {
  readonly extensions = [".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods"];

  async extract(path: string, data: ArrayBuffer): Promise<string | null> {
    const bytes = new Uint8Array(data);
    const title = attachmentTitle(path);
    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    try {
      switch (ext) {
        case ".docx":
          return await extractDocx(title, bytes);
        case ".pptx":
          return await extractPptx(title, bytes);
        case ".xlsx":
          return await extractXlsx(title, bytes);
        case ".odt":
          return await extractOpenDocument(title, bytes, "odt");
        case ".odp":
          return await extractOpenDocument(title, bytes, "odp");
        case ".ods":
          return await extractOpenDocument(title, bytes, "ods");
        default:
          return null;
      }
    } catch {
      // Corrupt/encrypted/not-a-zip/bomb: skip the attachment, never throw.
      return null;
    }
  }
}
