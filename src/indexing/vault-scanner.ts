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
 * Fold a folder setting to the form the path comparisons use. Drops the empty
 * and `.` segments that `normalizeVaultRelativePath` drops everywhere else, so
 * "./Private", "/Private/" and "Private" all name the same folder here as they
 * do in the rest of the codebase.
 */
function normalizeFolder(folder: string): string {
  return folder
    .trim()
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

/**
 * Fold a value for FILTER COMPARISON — never for storing a path or reading a
 * file, where the exact bytes on disk are what the adapter needs.
 *
 * Case folds because a user who types "private" for a folder named "Private"
 * means that folder, and on macOS and Windows the filesystem folds case anyway.
 *
 * Unicode normalization folds for the same reason one step further out: macOS
 * stores an accented filename DECOMPOSED (NFD — "e" plus a combining accent)
 * while the same name typed into the settings box arrives COMPOSED (NFC, one
 * codepoint). They are one name to a person and to the filesystem, but two
 * different strings, so an exclusion naming an accented folder silently matched
 * nothing and left those notes indexed and readable over the server — the same
 * failure direction as matching case exactly.
 */
function foldForCompare(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/**
 * True if `path` is inside `folder` (or equals it). Segment-boundary aware, and
 * folded (case + Unicode form) like the tag and pattern filters beside it.
 */
function isUnderFolder(path: string, folder: string): boolean {
  const f = foldForCompare(normalizeFolder(folder));
  if (f === "") return true;
  const p = foldForCompare(path);
  return p === f || p.startsWith(f + "/");
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

export function matchesPathPattern(path: string, pattern: string): boolean {
  const p = foldForCompare(pattern.trim());
  if (p === "") return false;
  const target = foldForCompare(path);
  if (p.includes("*")) {
    // Guard against pathological patterns (many wildcards → catastrophic
    // regex backtracking). Overly complex patterns degrade to a literal test.
    const wildcards = (p.match(/\*/g) ?? []).length;
    if (p.length > MAX_PATTERN_LENGTH || wildcards > MAX_WILDCARDS) {
      return target.includes(p.replace(/\*/g, ""));
    }
    return globToRegExp(p).test(target);
  }
  return target.includes(p);
}

export class VaultScanner {
  constructor(
    private readonly adapter: VaultAdapter,
    private readonly logger: Logger = NULL_LOGGER,
  ) {}

  /** Fast path/folder-only eligibility (no file read). */
  isPathEligible(path: string, config: ScanConfig): boolean {
    const included = config.includedFolders.map(normalizeFolder).filter(Boolean);
    if (included.length > 0 && !included.some((f) => isUnderFolder(path, f))) {
      return false;
    }
    if (config.excludedFolders.some((f) => isUnderFolder(path, normalizeFolder(f)))) {
      return false;
    }
    if (config.excludedPathPatterns.some((pat) => matchesPathPattern(path, pat))) {
      return false;
    }
    return true;
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
    const eligible = files.filter((f) => this.isPathEligible(f.path, config));
    const out: ScanResult[] = [];

    for (const file of eligible) {
      if (knownMtimes?.get(file.path) === file.mtime) {
        out.push({ path: file.path, mtime: file.mtime, unchanged: true });
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential reads keep peak memory at one note; a whole vault read in parallel would hold every note at once
        const content = await this.adapter.read(normalizeVaultRelativePath(file.path));
        const metadata = extractMetadata(content);
        if (this.hasExcludedTag(metadata, config.excludedTags)) continue;
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
