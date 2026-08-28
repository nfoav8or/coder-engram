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
/**
 * An inline `#tag`, using Obsidian's own character rules.
 *
 * Letters and numbers are matched in **any script**, because an ASCII-only
 * class did not simply skip a non-Latin tag — it silently truncated one.
 * `#privé` was harvested as `priv` and `#личное` as nothing at all, while the
 * same tags written in frontmatter parsed correctly. Tag exclusion is a privacy
 * control ("notes with any of these tags are never indexed"), so a tag the
 * extractor cannot spell is an exclusion that **fails open**: the user marks a
 * note to keep it away from the agent, and it is indexed and served anyway.
 * Combining marks (`\p{M}`) are part of a tag after its first character, so a
 * decomposed `#privé` is captured whole rather than truncated at the accent —
 * the scanner folds to NFC before comparing, so both encodings then match the
 * same exclusion. A mark cannot begin a tag, so the first character excludes it.
 */
/**
 * A tag is a `#` that does not follow a word character, a `/`, or a markdown
 * link's `](`.
 *
 * The prefix used to be an enumerated class (`[\s(]`), which meant any other
 * punctuation before the `#` silently dropped the tag: `**#private**` (bold,
 * an ordinary way to write one), `urgent,#private,todo`, and `"#private"` all
 * extracted NOTHING. That is the same fail-open shape as the 0.10.4 and 0.9.9
 * bugs — a note the user tagged to keep out of the index is indexed and served
 * anyway — so the rule is now stated as what a tag may NOT follow.
 *
 * The two exclusions are what the old narrow class bought by accident and must
 * keep buying: `/` keeps a URL fragment (`https://x.example/#section`) from
 * reading as a tag, and `](` keeps a markdown anchor link (`[text](#section)`)
 * from doing the same — the latter was a live false positive under the old
 * pattern, since `(` was an allowed prefix.
 *
 * Lookbehind rather than a consuming group: it does not eat the preceding
 * character, so adjacent matches are found independently. ES2018, and this
 * bundle targets ES2020.
 */
const INLINE_TAG = /(?<![\p{L}\p{N}_/])(?<!\]\()#([\p{L}\p{N}_][\p{L}\p{N}\p{M}_/-]*)/gu;

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
  // An unterminated block (truncated write, sync conflict, hand-edit in
  // progress) is still scanned for tags, to EOF. Its content stays body —
  // `bodyStartLine` is left at 0, so nothing is hidden from the index — but
  // the tags it declares are honored. Dropping them was fail-open: a note
  // whose only exclusion marker is a YAML `tags:` entry has no `#` anywhere
  // for the inline pattern to find, so it was indexed and served despite the
  // user having excluded it. Over-excluding on a damaged file is the safe
  // direction; under-excluding is the one that leaks.
  const parseTo = end === -1 ? lines.length : end;
  if (end !== -1) result.bodyStartLine = end + 1;

  let currentListKey: "tags" | "aliases" | null = null;
  for (let i = 1; i < parseTo; i++) {
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
 * The link scans are hand-rolled index walkers, not regexes: the natural
 * regexes (`\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]`, `\[[^\]]*\]\(([^)]+)\)`)
 * backtrack quadratically on `[` floods, and with attachment indexing this
 * function runs over untrusted extracted bytes on every refresh — 100 KB of
 * `[` cost ~13 s of main-thread time. The walkers preserve the regex
 * semantics (same targets, same skips) in a single linear pass.
 */

/** Wikilink targets: `[[target]]`, `[[target|alias]]`, `[[target#heading]]`. */
function extractWikilinkTargets(prose: string): string[] {
  const out: string[] = [];
  let i = 0;
  // `close` (the first `]]` at/after the candidate) is monotone, so it is
  // memoized across candidates — re-searching it per candidate is what would
  // make a `[[`-flood quadratic.
  let close = -1;
  for (;;) {
    const open = prose.indexOf("[[", i);
    if (open < 0) return out;
    const innerStart = open + 2;
    if (close < innerStart) {
      close = prose.indexOf("]]", innerStart);
      if (close < 0) return out;
    }
    // One pass over the candidate: the target ends at the first `#`/`|`, and
    // a lone `]` anywhere before `close` invalidates the whole candidate.
    let cut = close;
    let bad = -1;
    for (let k = innerStart; k < close; k++) {
      const c = prose.charCodeAt(k);
      if (c === 0x5d /* ] */) {
        bad = k;
        break;
      }
      if (cut === close && (c === 0x23 /* # */ || c === 0x7c /* | */)) {
        cut = k;
        // An empty target kills the candidate no matter what follows — bail
        // now, or a `[[#`-flood re-scans to a distant `]]` per candidate.
        if (cut === innerStart) break;
      }
    }
    if (bad >= 0) {
      // No candidate opening at/before `bad` can succeed; skip past it so
      // rejected input is never re-scanned.
      i = bad + 1;
      continue;
    }
    if (cut === innerStart) {
      i = innerStart; // empty target ("[[#…" / "[[|…" / "[[]]")
      continue;
    }
    out.push(prose.slice(innerStart, cut));
    i = close + 2;
  }
}

/** Markdown-link targets: the `(url)` of `[text](url)`; text may not contain `]`. */
function extractMdLinkTargets(prose: string): string[] {
  const out: string[] = [];
  let i = 0;
  // First `)` at/after the candidate URL — monotone, memoized like `close`
  // above (a `](`-flood ahead of one distant `)` is quadratic otherwise).
  let urlEnd = -1;
  for (;;) {
    const bracket = prose.indexOf("](", i);
    if (bracket < 0) return out;
    if (urlEnd < bracket + 2) {
      urlEnd = prose.indexOf(")", bracket + 2);
      if (urlEnd < 0) return out;
    }
    // Valid link text starts at the earliest `[` after the previous `]` (text
    // may contain `[` but never `]`). Bounded below by `i`, so backscans over
    // successive candidates cover disjoint ranges.
    let start = -1;
    for (let k = bracket - 1; k >= i; k--) {
      const c = prose.charCodeAt(k);
      if (c === 0x5d /* ] */) break;
      if (c === 0x5b /* [ */) start = k;
    }
    if (start < 0 || urlEnd === bracket + 2) {
      i = bracket + 2; // no opening bracket / empty URL
      continue;
    }
    out.push(prose.slice(bracket + 2, urlEnd));
    i = urlEnd + 1;
  }
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
    if (!/^\d+$/.test(m[1])) tags.push(m[1]);
  }

  const links: string[] = [];
  for (const raw of extractWikilinkTargets(prose)) {
    links.push(raw.trim());
  }
  for (const raw of extractMdLinkTargets(prose)) {
    const target = raw.trim();
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
