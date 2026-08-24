/**
 * project-memory — scaffold and enumerate per-project memory folders under
 * `<root>/Memory/Projects/<name>/`. Also handles session notes.
 *
 * Scaffolding is non-destructive: template files are only created if missing,
 * never overwritten, so a user's edits are always preserved.
 */

import { VaultAdapter } from "../core/vault-adapter";
import { MemoryPaths, ProjectPaths, resolveProjectPaths } from "./memory-types";
import { resolveInVault } from "../utils/paths";
import { Logger, NULL_LOGGER } from "../utils/logger";

const TEMPLATES: Record<keyof Omit<ProjectPaths, "name" | "folder" | "sessions">, (name: string) => string> = {
  overview: (n) => `# ${n} — Overview\n\nHigh-level description of the ${n} project.\n`,
  architecture: (n) => `# ${n} — Architecture\n\nKey components, data flow, and design notes.\n`,
  decisions: (n) => `# ${n} — Decisions\n\nDecision log (most recent first).\n`,
  tasks: (n) => `# ${n} — Tasks\n\n- [ ] First task\n`,
  openQuestions: (n) => `# ${n} — Open Questions\n\n- Question to resolve\n`,
};

export class ProjectMemory {
  private readonly logger: Logger;

  constructor(
    private readonly adapter: VaultAdapter,
    private readonly paths: MemoryPaths,
    logger: Logger = NULL_LOGGER,
  ) {
    this.logger = logger;
  }

  /** List project names discovered under the projects root. */
  async listProjects(): Promise<string[]> {
    const files = await this.adapter.listMarkdownFiles();
    const prefix = this.paths.projects + "/";
    const names = new Set<string>();
    for (const f of files) {
      if (f.path.startsWith(prefix)) {
        const rest = f.path.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) names.add(name);
      }
    }
    return Array.from(names).sort();
  }

  /** Create a project's folder structure, writing only missing template files. */
  async createProject(name: string): Promise<ProjectPaths> {
    const project = resolveProjectPaths(this.paths, name);
    await this.adapter.ensureFolder(project.folder);
    await this.adapter.ensureFolder(project.sessions);

    for (const [key, template] of Object.entries(TEMPLATES)) {
      const filePath = project[key as keyof typeof TEMPLATES];
      // eslint-disable-next-line no-await-in-loop -- scaffolding a fixed handful of template files; sequential keeps the vault quiet
      if (!(await this.adapter.exists(filePath))) {
        // eslint-disable-next-line no-await-in-loop -- must follow the exists() check above, so it cannot be hoisted out of the loop
        await this.adapter.write(filePath, template(project.name));
      }
    }
    this.logger.info("Created project memory", { project: project.name });
    return project;
  }

  /**
   * Create (or return) a session note for a project, named by timestamp.
   * @param stamp session filename stem, e.g. "2026-07-03-1422".
   */
  async startSession(name: string, stamp: string): Promise<string> {
    const project = resolveProjectPaths(this.paths, name);
    await this.adapter.ensureFolder(project.sessions);
    // `stamp` is caller-supplied (currently always a generated timestamp, but
    // nothing here should assume that); resolve it against the sessions root
    // rather than concatenating, so a stamp containing ".." can't write
    // outside the project's session folder.
    const file = resolveInVault(project.sessions, `${stamp}.md`);
    if (!(await this.adapter.exists(file))) {
      await this.adapter.write(
        file,
        `# Session ${stamp} — ${project.name}\n\n## Goals\n\n## Notes\n\n## Outcomes\n`,
      );
    }
    return file;
  }

  /** Append a closing summary to a session note. */
  async endSession(sessionFile: string, summary: string): Promise<void> {
    await this.adapter.append(sessionFile, `\n## Session closed\n\n${summary.trim()}\n`);
  }
}
