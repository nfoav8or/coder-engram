import { describe, it, expect } from "vitest";
import {
  isPluginArtifact,
  resolveMemoryPaths,
  resolveProjectPaths,
  sanitizeProjectName,
} from "../src/memory/memory-types";
import { MemoryStore } from "../src/memory/memory-store";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { PathSecurityError } from "../src/utils/errors";

describe("resolveMemoryPaths", () => {
  it("computes the default layout under the root", () => {
    const p = resolveMemoryPaths("Claude Code");
    expect(p.pendingMemoryFile).toBe("Claude Code/Memory/Inbox/pending-memory.md");
    expect(p.rejectedMemoryFile).toBe("Claude Code/Memory/Inbox/rejected-memory.md");
    expect(p.globalFiles.profile).toBe("Claude Code/Memory/Global/profile.md");
    expect(p.chunksFile).toBe("Claude Code/Index/chunks.json");
  });

  it("rejects a subfolder name that escapes the root", () => {
    expect(() =>
      resolveMemoryPaths("Claude Code", {
        memoryFolder: "../Escape",
        globalFolder: "Global",
        projectsFolder: "Projects",
        inboxFolder: "Inbox",
        indexFolder: "Index",
        configFolder: "Config",
        pendingFile: "pending-memory.md",
        rejectedFile: "rejected-memory.md",
      }),
    ).toThrow(PathSecurityError);
  });
});

describe("isPluginArtifact", () => {
  const paths = resolveMemoryPaths("Claude Code");

  it("matches the plugin's own Index/ and Config/ artifacts", () => {
    expect(isPluginArtifact(paths, "Claude Code/Index/chunks.json")).toBe(true);
    expect(isPluginArtifact(paths, "Claude Code/Index/embeddings.json")).toBe(true);
    expect(isPluginArtifact(paths, "Claude Code/Config/plugin-settings-backup.json")).toBe(true);
  });

  it("does not match ordinary vault or memory files", () => {
    expect(isPluginArtifact(paths, "Notes/a.md")).toBe(false);
    // Memory files are user-reviewable content — edits there SHOULD reindex.
    expect(isPluginArtifact(paths, "Claude Code/Memory/Inbox/pending-memory.md")).toBe(false);
    // An Index/ look-alike outside the root is a normal file.
    expect(isPluginArtifact(paths, "Other/Index/chunks.json")).toBe(false);
  });

  it("fails open (not an artifact) on an unparseable path", () => {
    expect(isPluginArtifact(paths, "../escape.md")).toBe(false);
  });
});

describe("sanitizeProjectName", () => {
  it("strips path separators and illegal characters", () => {
    expect(sanitizeProjectName("My/Project:Name")).toBe("My-ProjectName");
  });
  it("rejects names that reduce to nothing or dots", () => {
    expect(() => sanitizeProjectName("..")).toThrow(PathSecurityError);
    expect(() => sanitizeProjectName("   ")).toThrow(PathSecurityError);
  });
});

describe("resolveProjectPaths", () => {
  it("resolves project files under the projects root", () => {
    const paths = resolveMemoryPaths("Claude Code");
    const proj = resolveProjectPaths(paths, "Demo");
    expect(proj.folder).toBe("Claude Code/Memory/Projects/Demo");
    expect(proj.decisions).toBe("Claude Code/Memory/Projects/Demo/decisions.md");
    expect(proj.sessions).toBe("Claude Code/Memory/Projects/Demo/sessions");
  });
});

describe("MemoryStore", () => {
  it("scaffolds base folders and global files", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const paths = resolveMemoryPaths("Claude Code");
    const store = new MemoryStore(adapter, paths);
    await store.ensureScaffold();
    const snap = adapter.snapshot();
    expect(Object.keys(snap)).toContain("Claude Code/Memory/Global/profile.md");
    expect(Object.keys(snap)).toContain("Claude Code/Memory/Global/preferences.md");
    expect(Object.keys(snap)).toContain("Claude Code/Memory/Global/conventions.md");
  });

  it("creates a project and lists it", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const paths = resolveMemoryPaths("Claude Code");
    const store = new MemoryStore(adapter, paths);
    await store.projects.createProject("Demo");
    expect(await store.listProjects()).toContain("Demo");
    const parts = await store.getProjectContext("Demo");
    // Parts are path-labeled so consumers can make targeted follow-up reads.
    expect(parts.map((p) => p.content).join("\n")).toContain("Demo — Overview");
    expect(parts[0].path).toBe("Claude Code/Memory/Projects/Demo/overview.md");
  });

  it("does not overwrite an existing project file", async () => {
    const adapter = new InMemoryVaultAdapter("v", {
      "Claude Code/Memory/Projects/Demo/overview.md": "# Custom overview\nkeep me",
    });
    const paths = resolveMemoryPaths("Claude Code");
    const store = new MemoryStore(adapter, paths);
    await store.projects.createProject("Demo");
    expect(await adapter.read("Claude Code/Memory/Projects/Demo/overview.md")).toContain("keep me");
  });

  it("returns recent sessions in descending order", async () => {
    const adapter = new InMemoryVaultAdapter("v", {
      "Claude Code/Memory/Projects/Demo/sessions/2026-07-01-0900.md": "s1",
      "Claude Code/Memory/Projects/Demo/sessions/2026-07-02-0900.md": "s2",
    });
    const paths = resolveMemoryPaths("Claude Code");
    const store = new MemoryStore(adapter, paths);
    const sessions = await store.getRecentSessions("Demo", 5);
    expect(sessions[0].path).toContain("2026-07-02");
  });
});
