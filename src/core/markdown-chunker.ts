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
   * 0-based inclusive start line of this chunk's SECTION in the original note.
   * When a long section is split into multiple windows, every window reports
   * the section's span (not the window's sub-span).
   */
  startLine: number;
  /** 0-based inclusive end line of this chunk's section in the original note. */
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

  // Split body into paragraphs and greedily pack. All windows of one section
  // share the section's line span (per-window line precision is deferred — no
  // M1 feature navigates by chunk line number; search opens notes by path).
  const paragraphs = bodyText.split(/\n{2,}/);
  const chunks: Chunk[] = [];
  const headerPrefix = headerLine ? `${headerLine}\n\n` : "";
  let buffer = headerPrefix;
  let paragraphsInBuffer = 0;

  const push = (): void => {
    const text = buffer.trim();
    if (text.length > 0 && paragraphsInBuffer > 0) {
      chunks.push({
        heading: section.heading,
        headingPath: section.headingPath,
        text,
        startLine: section.startLine,
        endLine: section.endLine,
      });
    }
  };

  for (const para of paragraphs) {
    // Flush before adding this paragraph only if the buffer already holds body
    // content — never emit a header-only chunk when the first paragraph alone
    // overflows maxChars.
    if (buffer.length + para.length > maxChars && paragraphsInBuffer > 0) {
      push();
      const carry = overlapChars > 0 ? buffer.slice(-overlapChars) : "";
      buffer = headerPrefix + (carry ? `${carry}\n\n` : "");
      paragraphsInBuffer = 0;
    }
    buffer += para + "\n\n";
    paragraphsInBuffer++;
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
