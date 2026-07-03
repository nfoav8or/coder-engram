/**
 * memory-types — the memory data model and the vault folder layout.
 *
 * Every path here is resolved through `resolveInVault`, so the entire memory
 * tree is guaranteed to live inside the configured root inside the vault. If a
 * user misconfigures a subfolder to something that would escape, path
 * resolution throws rather than writing outside the root.
 */

import { resolveInVault, joinVaultPath } from "../utils/paths";
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
}

export const DEFAULT_LAYOUT: MemoryLayoutConfig = {
  memoryFolder: "Memory",
  globalFolder: "Global",
  projectsFolder: "Projects",
  inboxFolder: "Inbox",
  indexFolder: "Index",
  configFolder: "Config",
  pendingFile: "pending-memory.md",
};

export interface MemoryPaths {
  root: string;
  memory: string;
  global: string;
  projects: string;
  inbox: string;
  index: string;
  config: string;
  pendingMemoryFile: string;
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
  const global = resolveInVault(memory, layout.globalFolder);
  const projects = resolveInVault(memory, layout.projectsFolder);
  const inbox = resolveInVault(memory, layout.inboxFolder);
  const index = resolveInVault(root, layout.indexFolder);
  const config = resolveInVault(root, layout.configFolder);

  return {
    root: resolveInVault(root, ""),
    memory,
    global,
    projects,
    inbox,
    index,
    config,
    pendingMemoryFile: resolveInVault(inbox, layout.pendingFile),
    chunksFile: resolveInVault(index, "chunks.json"),
    metadataFile: resolveInVault(index, "metadata.json"),
    embeddingsFile: resolveInVault(index, "embeddings.json"),
    settingsBackupFile: resolveInVault(config, "plugin-settings-backup.json"),
    globalFiles: {
      profile: resolveInVault(global, "profile.md"),
      preferences: resolveInVault(global, "preferences.md"),
      conventions: resolveInVault(global, "conventions.md"),
    },
  };
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
