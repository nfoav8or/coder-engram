/**
 * memory-types — the memory data model and the vault folder layout.
 *
 * Every path here is resolved through `resolveInVault`, so the entire memory
 * tree is guaranteed to live inside the configured root inside the vault. If a
 * user misconfigures a subfolder to something that would escape, path
 * resolution throws rather than writing outside the root.
 */

import { resolveInVault, joinVaultPath, isInsideRoot } from "../utils/paths";
import { PathSecurityError } from "../utils/errors";

export type MemoryType =
  | "decision"
  | "note"
  | "task"
  | "open-question"
  | "action-item"
  | "preference"
  | "architecture"
  | "session";

/** Every `MemoryType`, in the order shown to a user. The one place this list
 * is written out — the MCP tool schema and the Add Memory modal both import
 * it, so a new type can't be added to one and silently missed by the other. */
export const MEMORY_TYPES: readonly MemoryType[] = [
  "decision",
  "note",
  "task",
  "open-question",
  "action-item",
  "preference",
  "architecture",
  "session",
];

export type Confidence = "low" | "medium" | "high";

export interface MemoryEntry {
  type: MemoryType;
  content: string;
  project?: string;
  /** Where this memory came from, e.g. "Claude Code", "Obsidian UI". */
  source: string;
  /** Originating command or MCP tool name. */
  originTool?: string;
  confidence?: Confidence;
  /** `<vault path>#<heading>` of the memory this entry replaces, if any. */
  supersedes?: string;
  /** `<vault path>#<heading>` of an existing memory this one overlaps. Set by
   * the engine at propose time; never accepted from a caller. */
  similarTo?: string;
  tags: string[];
  relatedPaths: string[];
  /** ms since epoch. */
  timestamp: number;
}

export interface MemoryLayoutConfig {
  memoryFolder: string;
  globalFolder: string;
  projectsFolder: string;
  inboxFolder: string;
  indexFolder: string;
  configFolder: string;
  pendingFile: string;
  rejectedFile: string;
  supersededFile: string;
}

export const DEFAULT_LAYOUT: MemoryLayoutConfig = {
  memoryFolder: "Memory",
  globalFolder: "Global",
  projectsFolder: "Projects",
  inboxFolder: "Inbox",
  indexFolder: "Index",
  configFolder: "Config",
  pendingFile: "pending-memory.md",
  rejectedFile: "rejected-memory.md",
  supersededFile: "superseded-memory.md",
};

export interface MemoryPaths {
  root: string;
  memory: string;
  /** Resolved path of the Global memory folder. Named `globalDir` rather than
   * `global` because Obsidian's plugin review flags the bare identifier as a
   * reach for Node's `global` object — a false positive on a property name,
   * but one that would be reported on every release. */
  globalDir: string;
  projects: string;
  inbox: string;
  index: string;
  config: string;
  pendingMemoryFile: string;
  /** Ledger of discarded proposals. Lives beside the inbox: both are
   * plugin-managed review artifacts, not user-authored memory. */
  rejectedMemoryFile: string;
  /** Ledger of memories retired by a later applied entry. */
  supersededMemoryFile: string;
  chunksFile: string;
  metadataFile: string;
  embeddingsFile: string;
  settingsBackupFile: string;
  globalFiles: {
    profile: string;
    preferences: string;
    conventions: string;
  };
}

/**
 * Resolve the full memory folder layout under `root`. Throws
 * {@link PathSecurityError} if any subfolder name would escape the root.
 */
export function resolveMemoryPaths(
  root: string,
  layout: MemoryLayoutConfig = DEFAULT_LAYOUT,
): MemoryPaths {
  const memory = resolveInVault(root, layout.memoryFolder);
  const globalDir = resolveInVault(memory, layout.globalFolder);
  const projects = resolveInVault(memory, layout.projectsFolder);
  const inbox = resolveInVault(memory, layout.inboxFolder);
  const index = resolveInVault(root, layout.indexFolder);
  const config = resolveInVault(root, layout.configFolder);

  return {
    root: resolveInVault(root, ""),
    memory,
    globalDir,
    projects,
    inbox,
    index,
    config,
    pendingMemoryFile: resolveInVault(inbox, layout.pendingFile),
    rejectedMemoryFile: resolveInVault(inbox, layout.rejectedFile),
    supersededMemoryFile: resolveInVault(inbox, layout.supersededFile),
    chunksFile: resolveInVault(index, "chunks.json"),
    metadataFile: resolveInVault(index, "metadata.json"),
    embeddingsFile: resolveInVault(index, "embeddings.json"),
    settingsBackupFile: resolveInVault(config, "plugin-settings-backup.json"),
    globalFiles: {
      profile: resolveInVault(globalDir, "profile.md"),
      preferences: resolveInVault(globalDir, "preferences.md"),
      conventions: resolveInVault(globalDir, "conventions.md"),
    },
  };
}

/**
 * True when `path` is one of the plugin's own machine-managed artifacts — the
 * `Index/` cache files or the `Config/` settings backup. Vault-event watchers
 * must ignore these: the plugin writes them while refreshing, and reacting to
 * our own writes would schedule the next refresh indefinitely. An unparseable
 * path returns false (fail open: treat it as a normal vault file).
 */
export function isPluginArtifact(paths: MemoryPaths, path: string): boolean {
  try {
    return isInsideRoot(paths.index, path) || isInsideRoot(paths.config, path);
  } catch {
    return false;
  }
}

export interface ProjectPaths {
  name: string;
  folder: string;
  overview: string;
  architecture: string;
  decisions: string;
  tasks: string;
  openQuestions: string;
  sessions: string;
}

/** Turn an arbitrary project name into a safe single-segment folder name. */
export function sanitizeProjectName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/]+/g, "-") // no path separators
    .replace(/[<>:"|?*]+/g, "") // characters illegal on common filesystems
    .replace(/\.+$/g, "") // no trailing dots
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    throw new PathSecurityError(`Invalid project name: "${name}"`);
  }
  return cleaned;
}

/** Resolve the file layout for a single project under the projects root. */
export function resolveProjectPaths(paths: MemoryPaths, projectName: string): ProjectPaths {
  const safeName = sanitizeProjectName(projectName);
  const folder = resolveInVault(paths.projects, safeName);
  return {
    name: safeName,
    folder,
    overview: joinVaultPath(folder, "overview.md"),
    architecture: joinVaultPath(folder, "architecture.md"),
    decisions: joinVaultPath(folder, "decisions.md"),
    tasks: joinVaultPath(folder, "tasks.md"),
    openQuestions: joinVaultPath(folder, "open-questions.md"),
    sessions: joinVaultPath(folder, "sessions"),
  };
}
