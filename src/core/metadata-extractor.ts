/**
 * metadata-extractor — pull structured metadata out of a Markdown note.
 *
 * Dependency-free (no YAML library). We parse only the frontmatter fields we
 * care about (tags, aliases, title) plus inline tags, wikilinks and relative
 * Markdown links from the body. This is deliberately lenient: unknown or
 * malformed frontmatter is ignored rather than throwing.
 */

export interface NoteMetadata {
  tags: string[];
  aliases: string[];
  /** Wikilink targets and relative Markdown-link targets (external URLs excluded). */
  links: string[];
  title?: string;
  /** Line index (0-based) where the body begins, i.e. after frontmatter. */
  bodyStartLine: number;
}

const FRONTMATTER_FENCE = /^---\s*$/;
const INLINE_TAG = /(^|[\s(])#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g;
const WIKILINK = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
const MD_LINK = /\[[^\]]*\]\(([^)]+)\)/g;

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v.length > 0)));
}

/** Split "a, b, c" or "[a, b]" style scalar lists from minimal YAML. */
function parseInlineList(raw: string): string[] {
  const trimmed = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (trimmed.length === 0) return [];
  return trimmed
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

interface Frontmatter {
  tags: string[];
  aliases: string[];
  title?: string;
  bodyStartLine: number;
}

function parseFrontmatter(lines: string[]): Frontmatter {
  const result: Frontmatter = { tags: [], aliases: [], bodyStartLine: 0 };
  if (lines.length === 0 || !FRONTMATTER_FENCE.test(lines[0])) {
    return result;
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_FENCE.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) return result; // unterminated frontmatter → treat as body
  result.bodyStartLine = end + 1;

  let currentListKey: "tags" | "aliases" | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    // A block-list item: "  - value"
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentListKey) {
      const val = listItem[1].trim().replace(/^["']|["']$/g, "").replace(/^#/, "");
      if (val) result[currentListKey].push(val);
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) {
      currentListKey = null;
      continue;
    }
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (key === "tags" || key === "tag") {
      if (value) {
        result.tags.push(...parseInlineList(value).map((t) => t.replace(/^#/, "")));
        currentListKey = null;
      } else {
        currentListKey = "tags";
      }
    } else if (key === "aliases" || key === "alias") {
      if (value) {
        result.aliases.push(...parseInlineList(value));
        currentListKey = null;
      } else {
        currentListKey = "aliases";
      }
    } else if (key === "title") {
      result.title = value.replace(/^["']|["']$/g, "");
      currentListKey = null;
    } else {
      currentListKey = null;
    }
  }
  return result;
}

function isExternalUrl(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.startsWith("mailto:");
}

/**
 * Strip fenced code blocks (``` or ~~~) so `#ff0000`, `#include`, `[[x]]` etc.
 * inside code are not harvested as tags/links. The title H1 scan still uses the
 * full body (a real H1 is not inside a fence in practice).
 */
function stripFencedCode(body: string): string {
  const out: string[] = [];
  let inFence = false;
  let marker = "";
  for (const line of body.split("\n")) {
    const fence = line.match(/^(\s*)(```|~~~)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        marker = fence[2];
      } else if (line.trimStart().startsWith(marker)) {
        inFence = false;
      }
      continue; // drop the fence line itself
    }
    if (!inFence) out.push(line);
  }
  return out.join("\n");
}

export function extractMetadata(content: string): NoteMetadata {
  const lines = content.split(/\r?\n/);
  const fm = parseFrontmatter(lines);
  const body = lines.slice(fm.bodyStartLine).join("\n");
  const prose = stripFencedCode(body);

  const tags = [...fm.tags];
  for (const m of prose.matchAll(INLINE_TAG)) {
    // Skip pure-numeric tags like "#123" which are usually not real tags.
    if (!/^\d+$/.test(m[2])) tags.push(m[2]);
  }

  const links: string[] = [];
  for (const m of prose.matchAll(WIKILINK)) {
    links.push(m[1].trim());
  }
  for (const m of prose.matchAll(MD_LINK)) {
    const target = m[1].trim();
    if (!isExternalUrl(target)) links.push(target);
  }

  let title = fm.title;
  if (!title) {
    const h1 = body.match(/^#\s+(.+)$/m);
    if (h1) title = h1[1].trim();
  }

  return {
    tags: uniq(tags),
    aliases: uniq(fm.aliases),
    links: uniq(links),
    title,
    bodyStartLine: fm.bodyStartLine,
  };
}
