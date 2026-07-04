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

const DEFAULTS = { maxChars: 1200, overlapChars: 150 };

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^(\s*)(```|~~~)/;

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
  let inFence = false;
  let fenceMarker = "";

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

  for (let i = bodyStartLine; i < lines.length; i++) {
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

    const headingMatch = inFence ? null : line.match(HEADING);
    if (headingMatch) {
      flush(i - 1);
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      // Breadcrumb excludes the heading itself; push after computing path.
      startSection(text, i);
      headingStack.push({ level, text });
      continue;
    }

    if (!current) {
      // Preamble before the first heading.
      startSection("", i);
    }
    current!.lines.push(line);
  }
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
  const paragraphs = bodyText.split(/\n{2,}/);
  const bodyOffset = section.heading ? section.startLine + 1 : section.startLine;
  const blocks = segmentBlocks(section.lines, bodyOffset);
  // Defensive: only trust per-window spans when blocks align 1:1 with the
  // buffered paragraphs; otherwise fall back to the section span.
  const preciseLines = blocks.length === paragraphs.length;

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
  const maxChars = options.maxChars ?? DEFAULTS.maxChars;
  const overlapChars = options.overlapChars ?? DEFAULTS.overlapChars;
  const bodyStartLine = options.bodyStartLine ?? 0;

  const lines = content.split(/\r?\n/);
  const sections = splitIntoSections(lines, bodyStartLine);
  const chunks: Chunk[] = [];
  for (const section of sections) {
    chunks.push(...windowSection(section, maxChars, overlapChars));
  }
  return chunks;
}
