/**
 * memory-store — read-side of the memory system plus base-scaffold creation.
 *
 * Provides the human/agent-facing "context" reads (global, project, sessions)
 * and ensures the base folder structure and global files exist. All writes
 * here are non-destructive (create-if-missing).
 */

import { VaultAdapter } from "../core/vault-adapter";
import { MemoryPaths, resolveProjectPaths } from "./memory-types";
import { ProjectMemory } from "./project-memory";
import { Logger, NULL_LOGGER } from "../utils/logger";

export interface SessionNote {
  path: string;
  content: string;
}

const GLOBAL_TEMPLATES: Record<string, string> = {
  profile: "# Profile\n\nWho the user is, their role, and working context.\n",
  preferences: "# Preferences\n\nHow the user likes to work. Coding style, tools, conventions.\n",
  conventions: "# Conventions\n\nProject-agnostic conventions and standards to follow.\n",
};

export class MemoryStore {
  private readonly projectMemory: ProjectMemory;
  private readonly logger: Logger;

  constructor(
    private readonly adapter: VaultAdapter,
    private readonly paths: MemoryPaths,
    logger: Logger = NULL_LOGGER,
  ) {
    this.logger = logger;
    this.projectMemory = new ProjectMemory(adapter, paths, logger);
  }

  get projects(): ProjectMemory {
    return this.projectMemory;
  }

  /** Ensure base folders, global files, and an empty inbox exist. */
  async ensureScaffold(): Promise<void> {
    await this.adapter.ensureFolder(this.paths.global);
    await this.adapter.ensureFolder(this.paths.projects);
    await this.adapter.ensureFolder(this.paths.inbox);
    await this.adapter.ensureFolder(this.paths.index);
    await this.adapter.ensureFolder(this.paths.config);

    for (const [key, template] of Object.entries(GLOBAL_TEMPLATES)) {
      const file = this.paths.globalFiles[key as keyof typeof this.paths.globalFiles];
      // eslint-disable-next-line no-await-in-loop
      if (!(await this.adapter.exists(file))) {
        // eslint-disable-next-line no-await-in-loop
        await this.adapter.write(file, template);
      }
    }
    this.logger.info("Memory scaffold ensured", { root: this.paths.root });
  }

  private async readIfExists(path: string): Promise<string | null> {
    if (!(await this.adapter.exists(path))) return null;
    try {
      return await this.adapter.read(path);
    } catch {
      return null;
    }
  }

  /** Concatenated global memory (profile + preferences + conventions). */
  async getGlobalContext(): Promise<string> {
    const parts: string[] = [];
    for (const file of Object.values(this.paths.globalFiles)) {
      const content = await this.readIfExists(file);
      if (content && content.trim()) parts.push(content.trim());
    }
    return parts.join("\n\n---\n\n");
  }

  /** Concatenated project memory (overview → architecture → decisions → tasks → open questions). */
  async getProjectContext(name: string): Promise<string> {
    const project = resolveProjectPaths(this.paths, name);
    const order = [
      project.overview,
      project.architecture,
      project.decisions,
      project.tasks,
      project.openQuestions,
    ];
    const parts: string[] = [];
    for (const file of order) {
      const content = await this.readIfExists(file);
      if (content && content.trim()) parts.push(content.trim());
    }
    return parts.join("\n\n---\n\n");
  }

  async listProjects(): Promise<string[]> {
    return this.projectMemory.listProjects();
  }

  /** Most recent session notes for a project (by filename, descending). */
  async getRecentSessions(name: string, limit = 5): Promise<SessionNote[]> {
    const project = resolveProjectPaths(this.paths, name);
    const prefix = project.sessions + "/";
    const files = (await this.adapter.listMarkdownFiles())
      .filter((f) => f.path.startsWith(prefix))
      .sort((a, b) => b.path.localeCompare(a.path))
      .slice(0, limit);

    const out: SessionNote[] = [];
    for (const f of files) {
      const content = await this.readIfExists(f.path);
      if (content !== null) out.push({ path: f.path, content });
    }
    return out;
  }
}
