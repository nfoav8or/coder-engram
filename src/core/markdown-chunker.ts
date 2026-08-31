/**
 * markdown-chunker — split a note into retrieval-friendly chunks.
 *
 * Strategy: sections are delimited by ATX headings (`#`..`######`). Each
 * section becomes one chunk, carrying the heading breadcrumb and the line span
 * it covers. Sections longer than `maxChars` are split on paragraph (blank
 * line) boundaries into overlapping windows so retrieval stays granular.
 *
 * Fenced code blocks are treated as opaque: `#` inside a fence is NOT a
 * heading, so we don't split code.
 */

import { stripBom } from "../utils/text";

export interface Chunk {
  /** Nearest heading text for this chunk ("" for preamble before any heading). */
  heading: string;
  /** Breadcrumb of ancestor headings, outermost first. */
  headingPath: string[];
  /** Chunk text (trimmed). */
  text: string;
  /**
   * 0-based inclusive start line of this chunk in the original note. For a
   * section split into multiple windows, each window reports the line span of
   * the paragraphs it actually contains: the first window starts at the
   * heading line, and later windows start at their first body paragraph.
   */
  startLine: number;
  /** 0-based inclusive end line of this chunk's content in the original note. */
  endLine: number;
}

export interface ChunkOptions {
  /** Soft maximum characters per chunk before splitting a section. */
  maxChars?: number;
  /** Characters of overlap carried between split windows of one section. */
  overlapChars?: number;
  /** Line index (0-based) at which the body starts (skips frontmatter). */
  bodyStartLine?: number;
}

/**
 * Section budget and the overlap carried between windows of one section.
 *
 * `maxChars` is bounded by RELEVANCE, not by the cost curve. At production scale
 * (2000 notes) raising it from 1200 to 2000 cuts the corpus from 19,132 chunks
 * to 14,407 (−25%), the index from 18.0 MB to 16.1 MB, and lexical p50 from
 * 15.8 ms to 10.9 ms (−31%), with fewer, larger units to embed.
 *
 * Cost keeps improving past this — 2400 reaches −31% chunks and 10.0 ms — but
 * relevance does not. A fact buried inside a long section holds MRR 1.00 up to
 * 2200 and drops to 0.83 at 2400 (`longnote` class in the relevance eval): the
 * needle falls out of first place because a bigger chunk carries more unrelated
 * words and dilutes BM25 term density, which also pushed the chars an agent
 * reads before reaching the answer from 274 to 371. 2000 sits a step below that
 * boundary rather than on it, since the eval corpus is synthetic and the true
 * edge should not be trusted to the exact digit.
 *
 * Search cost to the agent is unaffected either way: snippets are a fixed 220
 * characters, and a result page measured 335 characters at every value tested.
 *
 * `overlapChars` is an absolute carry sized for sentence continuity across a
 * boundary, not a ratio of the budget, so it stays put.
 */
const DEFAULTS = { maxChars: 2000, overlapChars: 150 };

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^(\s*)(```|~~~)/;

/** An ATX heading line: its level (`#` count) and its title, trimmed. */
export interface MarkdownHeading {
  level: number;
  text: string;
}

/**
 * Walk Markdown lines, reporting which of them are real headings.
 *
 * Fence-aware, and the closing marker must MATCH the one that opened the fence
 * — a ``` inside a ~~~ block is content, not a terminator. This is the one
 * definition of "is this line a heading" in the codebase, exported because
 * getting it subtly wrong elsewhere has consequences beyond chunking: a second
 * scanner that toggled on any fence-looking line desynchronized on an unmatched
 * marker and, in `stripSupersededSections`, swallowed every remaining section
 * of a file instead of the one it was asked to retire. Two answers to this
 * question is one too many.
 */
export function scanMarkdownLines(
  lines: string[],
  visit: (index: number, line: string, heading: MarkdownHeading | null) => void,
  startLine = 0,
): void {
  let inFence = false;
  let fenceMarker = "";
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[2];
      } else if (line.trimStart().startsWith(fenceMarker)) {
        inFence = false;
      }
    }
    const m = inFence ? null : line.match(HEADING);
    visit(i, line, m ? { level: m[1].length, text: m[2].trim() } : null);
  }
}

interface RawSection {
  heading: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
  lines: string[];
}

function splitIntoSections(lines: string[], bodyStartLine: number): RawSection[] {
  const sections: RawSection[] = [];
  const headingStack: { level: number; text: string }[] = [];
  let current: RawSection | null = null;

  const flush = (endLine: number): void => {
    if (current) {
      current.endLine = endLine;
      sections.push(current);
      current = null;
    }
  };

  const startSection = (heading: string, startLine: number): void => {
    current = {
      heading,
      headingPath: headingStack.map((h) => h.text),
      startLine,
      endLine: startLine,
      lines: [],
    };
  };

  scanMarkdownLines(
    lines,
    (i, line, heading) => {
      if (heading) {
        flush(i - 1);
        const { level, text } = heading;
        while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop();
        }
        // Breadcrumb excludes the heading itself; push after computing path.
        startSection(text, i);
        headingStack.push({ level, text });
        return;
      }
      if (!current) {
        // Preamble before the first heading.
        startSection("", i);
      }
      current!.lines.push(line);
    },
    bodyStartLine,
  );
  flush(lines.length - 1);

  return sections.filter((s) => s.heading !== "" || s.lines.some((l) => l.trim() !== ""));
}

interface LineSpan {
  startIdx: number;
  endIdx: number;
}

/**
 * Segment body lines into paragraph blocks, tracking each block's original
 * (0-based) line range. A block is a maximal run of non-empty lines; only a
 * truly-empty ("") line separates blocks. This mirrors `text.split(/\n{2,}/)`
 * on the joined body (a whitespace-only line does not create the consecutive
 * newlines that split needs, so it stays inside its paragraph), keeping blocks
 * aligned 1:1 with those paragraphs. Each block's reported span then trims any
 * leading/trailing whitespace-only lines, matching `bodyText.trim()`, so a
 * stray space/tab line at a body edge never inflates the span.
 */
function segmentBlocks(lines: string[], bodyOffset: number): LineSpan[] {
  const blocks: LineSpan[] = [];
  let start = -1;
  const close = (endExclusive: number): void => {
    let s = start;
    let e = endExclusive - 1;
    while (s < e && lines[s].trim() === "") s++;
    while (e > s && lines[e].trim() === "") e--;
    blocks.push({ startIdx: bodyOffset + s, endIdx: bodyOffset + e });
    start = -1;
  };
  for (let j = 0; j < lines.length; j++) {
    if (lines[j] !== "") {
      if (start === -1) start = j;
    } else if (start !== -1) {
      close(j);
    }
  }
  if (start !== -1) close(lines.length);
  return blocks;
}

/**
 * Break one over-long paragraph into pieces of at most `limit` characters.
 *
 * Windowing splits on blank lines, so a paragraph that contains none cannot be
 * split by that rule at all — pasted JSON, base64, a wide table row, or wrapped
 * prose written without blank lines. Such a paragraph passed through whole and
 * defeated the section budget entirely (measured: a 100 KB paragraph produced
 * one 100,007-character chunk against a 1,200 target), which cost embedding
 * requests and collapsed retrieval granularity for that note.
 *
 * Pieces break at whitespace so words stay intact; a single token longer than
 * `limit` (a base64 blob has no spaces at all) is hard-sliced, because the
 * budget has to hold even when nothing in the text offers a boundary.
 */
function splitLongParagraph(para: string, limit: number): string[] {
  if (para.length <= limit) return [para];
  const pieces: string[] = [];
  let rest = para;
  while (rest.length > limit) {
    // Prefer the last whitespace inside the budget; fall back to a hard cut.
    const window = rest.slice(0, limit + 1);
    const ws = window.search(/\s\S*$/);
    const cut = ws > 0 ? ws : limit;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces.filter((p) => p.length > 0);
}

/** Pack paragraphs greedily into windows of ~maxChars with overlap. */
function windowSection(section: RawSection, maxChars: number, overlapChars: number): Chunk[] {
  const bodyText = section.lines.join("\n").trim();
  const headerLine = section.heading ? `${"#".repeat(section.headingPath.length + 1)} ${section.heading}` : "";
  const fullText = [headerLine, bodyText].filter(Boolean).join("\n\n").trim();

  if (fullText.length <= maxChars) {
    return fullText.length === 0
      ? []
      : [
          {
            heading: section.heading,
            headingPath: section.headingPath,
            text: fullText,
            startLine: section.startLine,
            endLine: section.endLine,
          },
        ];
  }

  // Split the body into paragraphs and greedily pack. The paragraph *text* is
  // buffered exactly as before (byte-for-byte identical chunk text); in
  // parallel we track each window's precise line span from the original body
  // paragraphs. The body's first line sits at `bodyOffset` in the note: one
  // past the heading for a heading section, or the section start for preamble.
  const rawParagraphs = bodyText.split(/\n{2,}/);
  const bodyOffset = section.heading ? section.startLine + 1 : section.startLine;
  const rawBlocks = segmentBlocks(section.lines, bodyOffset);
  // Defensive: only trust per-window spans when blocks align 1:1 with the
  // buffered paragraphs; otherwise fall back to the section span.
  const rawPrecise = rawBlocks.length === rawParagraphs.length;

  // A paragraph too big for the budget is broken up here, before packing, so
  // the greedy loop below never has to buffer something it cannot flush. Each
  // piece inherits its parent paragraph's line span: the pieces really do all
  // come from those lines (for the common single-line blob that span is exact),
  // and expanding paragraphs and blocks in lockstep keeps the 1:1 alignment
  // that per-window line precision depends on.
  const pieceLimit = Math.max(1, maxChars - (headerLine ? headerLine.length + 2 : 0) - Math.max(0, overlapChars));
  const paragraphs: string[] = [];
  const blocks: Array<{ startIdx: number; endIdx: number }> = [];
  for (let k = 0; k < rawParagraphs.length; k++) {
    const pieces = splitLongParagraph(rawParagraphs[k], pieceLimit);
    for (const piece of pieces) {
      paragraphs.push(piece);
      if (rawPrecise) blocks.push(rawBlocks[k]);
    }
  }
  const preciseLines = rawPrecise && blocks.length === paragraphs.length;

  const chunks: Chunk[] = [];
  const headerPrefix = headerLine ? `${headerLine}\n\n` : "";
  let buffer = headerPrefix;
  let paragraphsInBuffer = 0;
  let firstWindow = true;
  let curStart: number | null = null;
  let curEnd: number | null = null;

  const push = (): void => {
    const text = buffer.trim();
    if (text.length > 0 && paragraphsInBuffer > 0) {
      let startLine = section.startLine;
      let endLine = section.endLine;
      if (preciseLines && curStart !== null && curEnd !== null) {
        // The first window opens at the heading line; later windows open at
        // their first fresh body paragraph (the char-slice overlap carried
        // from the previous window is not counted toward the line span).
        startLine = firstWindow && section.heading ? section.startLine : curStart;
        endLine = curEnd;
      }
      chunks.push({ heading: section.heading, headingPath: section.headingPath, text, startLine, endLine });
      firstWindow = false;
    }
  };

  for (let k = 0; k < paragraphs.length; k++) {
    const para = paragraphs[k];
    // Flush before adding this paragraph only if the buffer already holds body
    // content — never emit a header-only chunk when the first paragraph alone
    // overflows maxChars.
    if (buffer.length + para.length > maxChars && paragraphsInBuffer > 0) {
      push();
      const carry = overlapChars > 0 ? buffer.slice(-overlapChars) : "";
      buffer = headerPrefix + (carry ? `${carry}\n\n` : "");
      paragraphsInBuffer = 0;
      curStart = null;
      curEnd = null;
    }
    buffer += para + "\n\n";
    paragraphsInBuffer++;
    if (preciseLines) {
      if (curStart === null) curStart = blocks[k].startIdx;
      curEnd = blocks[k].endIdx;
    }
  }
  push();
  return chunks;
}

export function chunkMarkdown(content: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULTS.maxChars);
  // Overlap is capped at half the window so at least half of every chunk is
  // new content. Nothing enforced any relation between the two, so a caller
  // passing `overlapChars >= maxChars` drove `pieceLimit` (below) to its floor
  // of 1 and `splitLongParagraph` hard-sliced every paragraph one character per
  // chunk — its whitespace preference is real, but no word boundary fits inside
  // a budget of 1. `< maxChars` is not enough of a bound: an overlap of
  // `maxChars - 1` leaves the same budget of 1. The shipped app always uses the
  // defaults (`IndexManager` passes no `ChunkOptions`, and 150 of 2000 is well
  // under the cap, so nothing about default output changes), which is why this
  // was never reachable in production — it is a precondition of an exported
  // pure function, held here rather than assumed of every caller.
  const overlapChars = Math.min(
    Math.max(0, options.overlapChars ?? DEFAULTS.overlapChars),
    Math.floor(maxChars / 2),
  );
  const bodyStartLine = options.bodyStartLine ?? 0;

  const lines = stripBom(content).split(/\r?\n/);
  // A file ending in a newline splits to a phantom trailing "" that is not a
  // real line. The windowed path already trims it, but a section that fits in
  // one chunk (the common case for ordinary notes) returns its span straight
  // from `splitIntoSections`, so the LAST chunk of most notes reported an
  // `endLine` one past the end — enough for "open at line" and
  // `get_note_context` to land past the content. Dropping the phantom shifts
  // no real line, since it is only ever the final element.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const sections = splitIntoSections(lines, bodyStartLine);
  const chunks: Chunk[] = [];
  for (const section of sections) {
    chunks.push(...windowSection(section, maxChars, overlapChars));
  }
  return chunks;
}
