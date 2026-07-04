/**
 * server/mcp-tools — the curated set of tools the local server exposes.
 *
 * SECURITY MODEL:
 *   - Every tool is EXPLICIT and query-scoped. There is no generic file
 *     read/write tool and no way to enumerate or dump the whole vault.
 *   - Writes go through `add_memory`, which ALWAYS proposes to the review inbox
 *     over the network — direct writes are never exposed to the server, even
 *     when the desktop `allowDirectWrites` setting is on.
 *   - Arguments are validated with the dependency-free validators before they
 *     reach the engine; retrieval limits are capped.
 *   - Expensive operations (reindex) are rate-limited.
 *
 * These handlers are pure with respect to Obsidian — they drive the same
 * EngramEngine the UI uses — so they are fully unit-testable with an in-memory
 * vault.
 */

import { EngramEngine } from "../engine";
import { EngramSettings } from "../settings/settings";
import { Logger } from "../utils/logger";
import { ValidationError } from "../utils/errors";
import {
  requireObject,
  requireString,
  optionalString,
  optionalStringArray,
  optionalNumber,
} from "../utils/validation";
import { MemoryEntry } from "../memory/memory-types";

/** JSON-Schema-shaped tool description advertised via `tools/list`. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Rate-limits repeated invocations of a keyed operation using an injected clock. */
export class RateLimiter {
  private readonly last = new Map<string, number>();
  private readonly windows = new Map<string, number[]>();
  constructor(private readonly clock: () => number) {}

  /** Throw a ValidationError if `key` was invoked within `cooldownMs`. */
  enforce(key: string, cooldownMs: number): void {
    const now = this.clock();
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < cooldownMs) {
      const wait = Math.ceil((cooldownMs - (now - prev)) / 1000);
      throw new ValidationError(`Rate limited: retry "${key}" in ${wait}s.`);
    }
    this.last.set(key, now);
  }

  /**
   * Sliding-window limit: throw if `key` has already been called `maxCalls`
   * times within the last `windowMs`. Bounds sustained flooding of a tool
   * (e.g. add_memory filling the inbox, or CPU-heavy search) without blocking
   * normal bursts.
   */
  enforceWindow(key: string, maxCalls: number, windowMs: number): void {
    const now = this.clock();
    const cutoff = now - windowMs;
    const recent = (this.windows.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= maxCalls) {
      throw new ValidationError(`Rate limited: too many "${key}" requests; slow down.`);
    }
    recent.push(now);
    this.windows.set(key, recent);
  }
}

export interface ToolContext {
  engine: EngramEngine;
  settings: EngramSettings;
  logger: Logger;
  clock: () => number;
  rateLimiter: RateLimiter;
}

export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<string>;

interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// --- caps / limits -----------------------------------------------------------

const SEARCH_MAX_LIMIT = 25;
const SEARCH_DEFAULT_LIMIT = 8;
const SESSIONS_MAX_LIMIT = 20;
const REINDEX_COOLDOWN_MS = 15_000;
const MS_PER_DAY = 86_400_000;
const RATE_WINDOW_MS = 60_000;
const SEARCH_MAX_PER_MINUTE = 120;
const ADD_MEMORY_MAX_PER_MINUTE = 60;
const SUMMARIZE_MAX_PER_MINUTE = 30;
const SUMMARY_DEFAULT_SENTENCES = 5;
const SUMMARY_MAX_SENTENCES = 20;
const NOTE_CONTEXT_MAX_PER_MINUTE = 60;
const NOTE_CONTEXT_DEFAULT_MAX_CHARS = 12_000;
const NOTE_CONTEXT_MAX_CHARS = 50_000;

const MEMORY_TYPES = [
  "decision",
  "note",
  "task",
  "open-question",
  "action-item",
  "preference",
  "architecture",
  "session",
];

// --- tool implementations ----------------------------------------------------

const searchTool: Tool = {
  definition: {
    name: "search_vault_memory",
    description:
      "Search the vault's memory/RAG index (lexical BM25). Returns query-scoped " +
      "chunks with their source note path, heading, and a snippet. Never returns " +
      "whole notes or the full vault.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        limit: {
          type: "number",
          description: `Max results (1–${SEARCH_MAX_LIMIT}, default ${SEARCH_DEFAULT_LIMIT}).`,
        },
        folder: { type: "string", description: "Restrict to notes under this vault-relative folder." },
        tag: { type: "string", description: "Restrict to notes carrying this tag (no leading #)." },
        project: { type: "string", description: "Restrict to a project under the projects root." },
        sinceDays: { type: "number", description: "Only notes modified within this many days." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("search_vault_memory", SEARCH_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const obj = requireObject(args, "arguments");
    const query = requireString(obj, "query", { maxLength: 2000 });
    const limit = Math.min(
      SEARCH_MAX_LIMIT,
      Math.max(1, Math.trunc(optionalNumber(obj, "limit", SEARCH_DEFAULT_LIMIT, { min: 1, max: SEARCH_MAX_LIMIT }))),
    );
    const folder = optionalString(obj, "folder", "", 1000) || undefined;
    const tag = optionalString(obj, "tag", "", 200) || undefined;
    const project = optionalString(obj, "project", "", 200) || undefined;
    const sinceDays = optionalNumber(obj, "sinceDays", 0, { min: 0, max: 36_500 });
    const sinceMtime = sinceDays > 0 ? ctx.clock() - sinceDays * MS_PER_DAY : undefined;

    const results = await ctx.engine.search({
      query,
      limit,
      filters: { folder, tag, project, sinceMtime },
    });

    if (results.length === 0) {
      return `No results for "${query}".`;
    }
    const blocks = results.map((r, i) => {
      const heading = r.chunk.headingPath.length ? r.chunk.headingPath.join(" › ") : r.chunk.heading || "(top)";
      return [
        `${i + 1}. ${r.chunk.notePath}  ·  ${heading}  ·  score ${r.score.toFixed(3)}`,
        r.snippet,
      ].join("\n");
    });
    return `${results.length} result(s):\n\n${blocks.join("\n\n")}`;
  },
};

const addMemoryTool: Tool = {
  definition: {
    name: "add_memory",
    description:
      "Propose a memory entry. Over the network this ALWAYS appends to the review " +
      "inbox (Memory/Inbox/pending-memory.md) — it never writes directly to a " +
      "memory file and never overwrites anything. The user reviews and applies it " +
      "in Obsidian.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory content (Markdown)." },
        type: { type: "string", enum: MEMORY_TYPES, description: "Kind of memory (default: note)." },
        project: { type: "string", description: "Associated project name, if any." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
        source: { type: "string", description: "Where this came from (default: MCP)." },
        relatedPaths: { type: "array", items: { type: "string" }, description: "Related note paths." },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("add_memory", ADD_MEMORY_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const obj = requireObject(args, "arguments");
    const content = requireString(obj, "content", { maxLength: 50_000 });
    const rawType = optionalString(obj, "type", "note", 40);
    const type = (MEMORY_TYPES.includes(rawType) ? rawType : "note") as MemoryEntry["type"];
    const project = optionalString(obj, "project", "", 200) || undefined;
    const source = optionalString(obj, "source", "MCP", 200) || "MCP";
    const tags = optionalStringArray(obj, "tags", 64);
    const relatedPaths = optionalStringArray(obj, "relatedPaths", 128);

    // Network path is inbox-only by construction: no `direct` option is passed.
    const path = await ctx.engine.addMemory({
      type,
      content,
      project,
      source,
      originTool: "mcp:add_memory",
      tags,
      relatedPaths,
    });
    return `Proposed memory appended to ${path} for review.`;
  },
};

const getProjectContextTool: Tool = {
  definition: {
    name: "get_project_context",
    description:
      "Return the concatenated project memory (overview → architecture → " +
      "decisions → tasks → open questions) for a named project.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Project name." } },
      required: ["project"],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    const obj = requireObject(args, "arguments");
    const project = requireString(obj, "project", { maxLength: 200 });
    const ctxText = await ctx.engine.getProjectContext(project);
    return ctxText.trim() || `No project memory found for "${project}".`;
  },
};

const getGlobalContextTool: Tool = {
  definition: {
    name: "get_global_context",
    description: "Return the concatenated global memory (profile + preferences + conventions).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  async handler(_args, ctx) {
    const text = await ctx.engine.getGlobalContext();
    return text.trim() || "No global memory recorded yet.";
  },
};

const listProjectsTool: Tool = {
  definition: {
    name: "list_projects",
    description: "List the project names under the projects root.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  async handler(_args, ctx) {
    const projects = await ctx.engine.listProjects();
    return projects.length ? projects.join("\n") : "No projects yet.";
  },
};

const getRecentSessionsTool: Tool = {
  definition: {
    name: "get_recent_sessions",
    description: "Return the most recent session notes for a project (most recent first).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name." },
        limit: { type: "number", description: `Max sessions (1–${SESSIONS_MAX_LIMIT}, default 5).` },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    const obj = requireObject(args, "arguments");
    const project = requireString(obj, "project", { maxLength: 200 });
    const limit = Math.min(
      SESSIONS_MAX_LIMIT,
      Math.max(1, Math.trunc(optionalNumber(obj, "limit", 5, { min: 1, max: SESSIONS_MAX_LIMIT }))),
    );
    const sessions = await ctx.engine.getRecentSessions(project, limit);
    if (sessions.length === 0) return `No sessions found for "${project}".`;
    return sessions
      .map((s) => `## ${s.path}\n\n${s.content.trim()}`)
      .join("\n\n---\n\n");
  },
};

const reindexTool: Tool = {
  definition: {
    name: "reindex_vault",
    description:
      "Rebuild the memory/RAG index from the current vault. Rate-limited; use " +
      "sparingly. Returns the resulting note and chunk counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  async handler(_args, ctx) {
    if (!ctx.settings.indexingEnabled) {
      throw new ValidationError("Indexing is disabled in settings.");
    }
    ctx.rateLimiter.enforce("reindex_vault", REINDEX_COOLDOWN_MS);
    const { noteCount, chunkCount } = await ctx.engine.reindex();
    return `Reindexed: ${noteCount} note(s), ${chunkCount} chunk(s).`;
  },
};

const summarizeNoteTool: Tool = {
  definition: {
    name: "summarize_note",
    description:
      "Extractive summary of a single INDEXED note: returns a few of the note's " +
      "OWN sentences (never generated/invented text), chosen by relevance. Only " +
      "notes present in the index can be summarized — an excluded or unindexed " +
      "note is refused, so this is not a general file-read.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path of the note to summarize." },
        maxSentences: {
          type: "number",
          description: `Max sentences (1–${SUMMARY_MAX_SENTENCES}, default ${SUMMARY_DEFAULT_SENTENCES}).`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("summarize_note", SUMMARIZE_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const obj = requireObject(args, "arguments");
    const path = requireString(obj, "path", { maxLength: 1000 });
    const maxSentences = Math.trunc(
      optionalNumber(obj, "maxSentences", SUMMARY_DEFAULT_SENTENCES, {
        min: 1,
        max: SUMMARY_MAX_SENTENCES,
      }),
    );
    const summary = await ctx.engine.summarizeNote(path, { maxSentences });
    if (summary.sentences.length === 0) {
      return `No summarizable content found in "${summary.notePath}".`;
    }
    const flags = summary.truncated ? " · note truncated for summarization" : "";
    const header =
      `Extractive summary of ${summary.notePath} ` +
      `(${summary.sentences.length} of ${summary.totalUnits} sentences · ${summary.method})${flags}:`;
    const body = summary.sentences.map((s) => `• ${s}`).join("\n");
    return `${header}\n\n${body}`;
  },
};

const getNoteContextTool: Tool = {
  definition: {
    name: "get_note_context",
    description:
      "Return the full INDEXED text of a single note, passage by passage, each " +
      "with its heading and line range — the natural follow-up to a search hit, " +
      "which only returns a short snippet. Only notes present in the index are " +
      "returned; an excluded or unindexed note is refused, so this is not a " +
      "general file-read.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path of the note to read." },
        maxChars: {
          type: "number",
          description:
            `Max characters returned (1000–${NOTE_CONTEXT_MAX_CHARS}, default ` +
            `${NOTE_CONTEXT_DEFAULT_MAX_CHARS}); the note is truncated past this.`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    ctx.rateLimiter.enforceWindow("get_note_context", NOTE_CONTEXT_MAX_PER_MINUTE, RATE_WINDOW_MS);
    const obj = requireObject(args, "arguments");
    const path = requireString(obj, "path", { maxLength: 1000 });
    const maxChars = Math.trunc(
      optionalNumber(obj, "maxChars", NOTE_CONTEXT_DEFAULT_MAX_CHARS, {
        min: 1000,
        max: NOTE_CONTEXT_MAX_CHARS,
      }),
    );

    // Indexed-only gate (same as summarize_note): an excluded/unindexed note has
    // no chunks and is refused, so this can never read a note the exclusion
    // filters were meant to keep out.
    const chunks = ctx.engine.getNoteChunks(path);
    if (chunks.length === 0) {
      throw new ValidationError(
        `Note "${path}" is not indexed (it may be excluded or outside the vault). ` +
          `Only indexed notes can be read.`,
      );
    }

    // Assemble passages until `maxChars` of note text is reached. `maxChars` is a
    // hard ceiling on the body: if even the first passage exceeds it (a single
    // giant chunk — e.g. a note that is one unbroken paragraph), it is clipped so
    // an oversized indexed note can't return unbounded output.
    const blocks: string[] = [];
    let used = 0;
    let truncated = false;
    for (const c of chunks) {
      const start = c.startLine + 1;
      const end = Math.max(start, c.endLine + 1);
      const lines = start === end ? `Line ${start}` : `Lines ${start}–${end}`;
      const heading = c.headingPath.length ? c.headingPath.join(" › ") : c.heading || "(top)";
      const block = `[${lines}] ${heading}\n${c.text}`;
      const sep = blocks.length > 0 ? 2 : 0; // "\n\n" between blocks
      if (used + sep + block.length > maxChars) {
        if (blocks.length === 0) blocks.push(block.slice(0, maxChars));
        truncated = true;
        break;
      }
      blocks.push(block);
      used += sep + block.length;
    }

    const header = `${chunks[0].notePath} — ${chunks.length} indexed passage(s):`;
    const body = blocks.join("\n\n");
    return truncated
      ? `${header}\n\n${body}\n\n…(truncated at ${maxChars} chars; narrow with search_vault_memory)`
      : `${header}\n\n${body}`;
  },
};

const ALL_TOOLS: Tool[] = [
  searchTool,
  addMemoryTool,
  summarizeNoteTool,
  getNoteContextTool,
  getProjectContextTool,
  getGlobalContextTool,
  listProjectsTool,
  getRecentSessionsTool,
  reindexTool,
];

/** Registry that resolves tool names to definitions and handlers. */
export class ToolRegistry {
  private readonly byName = new Map<string, Tool>();

  constructor(tools: Tool[] = ALL_TOOLS) {
    for (const t of tools) this.byName.set(t.definition.name, t);
  }

  list(): ToolDefinition[] {
    return [...this.byName.values()].map((t) => t.definition);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Invoke a tool by name; throws ValidationError for an unknown tool. */
  async call(name: string, args: unknown, ctx: ToolContext): Promise<string> {
    const tool = this.byName.get(name);
    if (!tool) {
      throw new ValidationError(`Unknown tool: ${name}`);
    }
    return tool.handler(args, ctx);
  }
}
