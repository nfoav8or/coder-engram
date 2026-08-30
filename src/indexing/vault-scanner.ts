/**
 * vault-scanner — enumerate the Markdown notes eligible for indexing.
 *
 * Applies, in order of cheapness:
 *   1. included-folder allowlist (empty = whole vault)
 *   2. excluded-folder denylist
 *   3. excluded path glob/substring patterns (for sensitive notes)
 *   4. excluded-tag denylist (requires reading + metadata extraction)
 *
 * Obsidian-agnostic: takes a VaultAdapter and a plain ScanConfig.
 */

import { VaultAdapter } from "../core/vault-adapter";
import { toMessage } from "../utils/errors";
import { extractMetadata, NoteMetadata } from "../core/metadata-extractor";
import { normalizeVaultRelativePath } from "../utils/paths";
import { Logger, NULL_LOGGER } from "../utils/logger";
import { foldForCompare, normalizeFolder } from "../utils/text";

export interface ScanConfig {
  /** Allowlist of folders; empty means the entire vault. */
  includedFolders: string[];
  /** Denylist of folders. */
  excludedFolders: string[];
  /** Tags (without leading `#`) that exclude a note from indexing. */
  excludedTags: string[];
  /** Glob (`*`, `**`) or substring patterns matched against the full path. */
  excludedPathPatterns: string[];
  /**
   * Whether binary attachments are indexed. Consumed by the ENGINE's
   * attachment pass, not this scanner — it lives here so the scan-config key
   * (fast-path invalidation + settings-change refresh) covers toggling it.
   */
  indexAttachments?: boolean;
}

export interface ScannedNote {
  path: string;
  mtime: number;
  content: string;
  metadata: NoteMetadata;
}

/**
 * A note the incremental fast path skipped: its mtime matched the caller's
 * known-mtimes map, so its content was NOT read from disk. Unchanged content
 * implies unchanged tags, so the note's prior eligibility verdict still holds.
 */
export interface UnchangedNote {
  path: string;
  mtime: number;
  unchanged: true;
}

export type ScanResult = ScannedNote | UnchangedNote;

export function isUnchangedNote(note: ScanResult): note is UnchangedNote {
  return "unchanged" in note && note.unchanged === true;
}

/**
 * True if `foldedPath` is inside `foldedFolder` (or equals it). Segment-boundary
 * aware. Both arguments must already be folded (case + Unicode form) — folding
 * is hoisted to the caller so a scan folds each invariant once, not once per
 * file-times-folder.
 */
function isUnderFolderFolded(foldedPath: string, foldedFolder: string): boolean {
  if (foldedFolder === "") return true;
  return foldedPath === foldedFolder || foldedPath.startsWith(foldedFolder + "/");
}

/** Convert a glob pattern to a RegExp. `**` matches across slashes, `*` within a segment. */
const DOUBLE_STAR = "\uE000"; // Unicode private-use sentinel; cannot appear in real vault paths

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, DOUBLE_STAR) // ** matches across slashes
    .replace(/\*/g, "[^/]*") // * matches within a segment
    .split(DOUBLE_STAR)
    .join(".*");
  return new RegExp(`^${escaped}$`, "i");
}

const MAX_PATTERN_LENGTH = 256;
const MAX_WILDCARDS = 12;

/**
 * Match a folded path against the pattern's literal fragments, in order.
 *
 * This is the fallback for a pattern too complex to compile safely, and it is
 * deliberately a SUPERSET of what the glob would match: the glob anchors its
 * literals (`^A[^/]*B$`), while this only requires A before B anywhere in the
 * path. For an exclusion — a privacy control — matching too much keeps a note
 * out of the index, and matching too little serves it to the agent. Only one of
 * those is a safe way to be wrong.
 *
 * Linear in the path length with no backtracking, which is the whole point:
 * the patterns that reach here are the ones a RegExp cannot be trusted with.
 */
function matchesFragmentsInOrder(foldedPath: string, fragments: string[]): boolean {
  let at = 0;
  for (const fragment of fragments) {
    const found = foldedPath.indexOf(fragment, at);
    if (found === -1) return false;
    at = found + fragment.length;
  }
  return true;
}

/** Compile one exclusion pattern into a matcher over an already-folded path,
 * so per-pattern folding and glob→RegExp compilation happen once per scan
 * rather than once per file. */
function compilePathPattern(
  pattern: string,
  onDegrade?: (pattern: string) => void,
): (foldedPath: string) => boolean {
  const p = foldForCompare(pattern.trim());
  if (p === "") return () => false;
  if (p.includes("*")) {
    // Guard against pathological patterns (many wildcards → catastrophic
    // regex backtracking).
    const wildcards = (p.match(/\*/g) ?? []).length;
    if (p.length > MAX_PATTERN_LENGTH || wildcards > MAX_WILDCARDS) {
      // This used to strip the wildcards and test `includes` on what was left,
      // which turned `Private/**/*.md` into the literal `Private/.md` — a
      // string essentially no path contains. The exclusion then matched
      // NOTHING and the notes it was meant to hide were indexed and served
      // over the MCP server, with nothing said. Ordered-fragment matching
      // errs the other way, and the degradation is logged either way.
      const fragments = p.split("*").filter((f) => f !== "");
      onDegrade?.(pattern);
      return (foldedPath) => matchesFragmentsInOrder(foldedPath, fragments);
    }
    const re = globToRegExp(p);
    return (foldedPath) => re.test(foldedPath);
  }
  return (foldedPath) => foldedPath.includes(p);
}

export class VaultScanner {
  constructor(
    private readonly adapter: VaultAdapter,
    private readonly logger: Logger = NULL_LOGGER,
  ) {}

  /** Fast path/folder-only eligibility (no file read). One compile per call —
   * per-file loops should compile once via {@link pathEligibility}. */
  isPathEligible(path: string, config: ScanConfig): boolean {
    return this.pathEligibility(config)(path);
  }

  /** Compile `config` into a per-path eligibility test. Folder normalization,
   * case/Unicode folding, and glob compilation are invariant across a scan, so
   * they happen here once instead of once per file (10^5 redundant NFC
   * normalizations per scan at 10k notes, on every debounced refresh). */
  pathEligibility(config: ScanConfig): (path: string) => boolean {
    const included = config.includedFolders
      .map(normalizeFolder)
      .filter(Boolean)
      .map(foldForCompare);
    // `.filter(Boolean)` for the same reason the include list has it: an empty
    // folder key matches every path (see isUnderFolderFolded), so a blank entry
    // here would exclude the entire vault. Defense in depth — settings
    // migration also drops blanks now.
    const excluded = config.excludedFolders
      .map((f) => normalizeFolder(f))
      .filter(Boolean)
      .map(foldForCompare);
    // Not `.map(compilePathPattern)`: `map` passes the index as the second
    // argument, which would land in `onDegrade`.
    const patterns = config.excludedPathPatterns.map((pattern) =>
      compilePathPattern(pattern, (raw) =>
        this.logger.warn(
          "Excluded path pattern is too complex to match exactly; falling back to a broader match",
          { pattern: raw },
        ),
      ),
    );
    return (path) => {
      const p = foldForCompare(path);
      if (included.length > 0 && !included.some((f) => isUnderFolderFolded(p, f))) {
        return false;
      }
      if (excluded.some((f) => isUnderFolderFolded(p, f))) return false;
      if (patterns.some((matches) => matches(p))) return false;
      return true;
    };
  }

  private hasExcludedTag(metadata: NoteMetadata, excludedTags: string[]): boolean {
    if (excludedTags.length === 0) return false;
    const noteTags = new Set(metadata.tags.map((t) => foldForCompare(t).replace(/^#/, "")));
    return excludedTags.some((t) => noteTags.has(foldForCompare(t).replace(/^#/, "")));
  }

  /** Content-level eligibility (tag exclusions) — used by the engine's
   * attachment pass so extracted text obeys the same rules as notes. */
  isMetadataEligible(metadata: NoteMetadata, config: ScanConfig): boolean {
    return !this.hasExcludedTag(metadata, config.excludedTags);
  }

  /**
   * Scan the vault and return eligible notes with content + metadata.
   * Read/parse failures on individual notes are logged and skipped, never fatal.
   *
   * With `knownMtimes` (the incremental path), a file whose mtime matches the
   * map is returned as a content-less {@link UnchangedNote} WITHOUT touching
   * disk — this is what keeps a debounced refresh O(changed) in file I/O
   * instead of re-reading the whole vault. The tag-exclusion check needs
   * content, but an unchanged note's tags are unchanged too, so its prior
   * verdict stands; a note the caller doesn't know (e.g. previously
   * tag-excluded, so absent from the map) is always read and re-checked.
   */
  async scan(config: ScanConfig): Promise<ScannedNote[]>;
  async scan(config: ScanConfig, knownMtimes: Map<string, number>): Promise<ScanResult[]>;
  async scan(config: ScanConfig, knownMtimes?: Map<string, number>): Promise<ScanResult[]> {
    const files = await this.adapter.listMarkdownFiles();
    const eligibleByPath = this.pathEligibility(config);
    const eligible = files.filter((f) => eligibleByPath(f.path));
    const out: ScanResult[] = [];
    // Snapshotted once, like the folder/pattern filters `pathEligibility`
    // hoists: `config` is the settings object's own array, and the per-file
    // loop below awaits a disk read, so a settings edit mid-scan could
    // otherwise apply the old tag list to some notes and the new one to
    // others within a single scan.
    const excludedTags = config.excludedTags;

    for (const file of eligible) {
      if (knownMtimes?.get(file.path) === file.mtime) {
        out.push({ path: file.path, mtime: file.mtime, unchanged: true });
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential reads keep peak memory at one note; a whole vault read in parallel would hold every note at once
        const content = await this.adapter.read(normalizeVaultRelativePath(file.path));
        const metadata = extractMetadata(content);
        if (this.hasExcludedTag(metadata, excludedTags)) continue;
        out.push({ path: file.path, mtime: file.mtime, content, metadata });
      } catch (err) {
        this.logger.warn(`Skipped unreadable note: ${file.path}`, {
          error: toMessage(err),
        });
      }
    }
    return out;
  }
}
