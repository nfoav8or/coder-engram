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

function normalizeFolder(folder: string): string {
  const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
  return trimmed;
}

/** True if `path` is inside `folder` (or equals it). Segment-boundary aware. */
function isUnderFolder(path: string, folder: string): boolean {
  const f = normalizeFolder(folder);
  if (f === "") return true;
  return path === f || path.startsWith(f + "/");
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
  const p = pattern.trim();
  if (p === "") return false;
  if (p.includes("*")) {
    // Guard against pathological patterns (many wildcards → catastrophic
    // regex backtracking). Overly complex patterns degrade to a literal test.
    const wildcards = (p.match(/\*/g) ?? []).length;
    if (p.length > MAX_PATTERN_LENGTH || wildcards > MAX_WILDCARDS) {
      return path.toLowerCase().includes(p.replace(/\*/g, "").toLowerCase());
    }
    return globToRegExp(p).test(path);
  }
  return path.toLowerCase().includes(p.toLowerCase());
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
    const noteTags = new Set(metadata.tags.map((t) => t.toLowerCase().replace(/^#/, "")));
    return excludedTags.some((t) => noteTags.has(t.toLowerCase().replace(/^#/, "")));
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
        // eslint-disable-next-line no-await-in-loop
        const content = await this.adapter.read(normalizeVaultRelativePath(file.path));
        const metadata = extractMetadata(content);
        if (this.hasExcludedTag(metadata, config.excludedTags)) continue;
        out.push({ path: file.path, mtime: file.mtime, content, metadata });
      } catch (err) {
        this.logger.warn(`Skipped unreadable note: ${file.path}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }
}
