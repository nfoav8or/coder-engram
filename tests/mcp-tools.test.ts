import { describe, it, expect, beforeEach } from "vitest";
import { EngramEngine } from "../src/engine";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { DEFAULT_SETTINGS, EngramSettings } from "../src/settings/settings";
import { NULL_LOGGER } from "../src/utils/logger";
import { ToolRegistry, ToolContext, RateLimiter } from "../src/server/mcp-tools";

function makeContext(seed: Record<string, string> = {}, overrides: Partial<EngramSettings> = {}) {
  const adapter = new InMemoryVaultAdapter("v", seed);
  const settings: EngramSettings = { ...DEFAULT_SETTINGS, ...overrides };
  let t = 1_000;
  const clock = () => t++;
  const engine = new EngramEngine(adapter, settings, NULL_LOGGER, clock);
  const ctx: ToolContext = {
    engine,
    settings,
    logger: NULL_LOGGER,
    clock,
    rateLimiter: new RateLimiter(() => 0), // fixed clock: same instant every call
  };
  return { adapter, engine, ctx };
}

describe("ToolRegistry", () => {
  it("lists the expected tools with input schemas", () => {
    const registry = new ToolRegistry();
    const names = registry.list().map((t) => t.name);
    expect(names).toContain("search_vault_memory");
    expect(names).toContain("add_memory");
    expect(names).toContain("get_project_context");
    expect(names).toContain("get_global_context");
    expect(names).toContain("list_projects");
    expect(names).toContain("get_recent_sessions");
    expect(names).toContain("reindex_vault");
    expect(names).toContain("get_note_context");
    for (const def of registry.list()) {
      expect(def.inputSchema.type).toBe("object");
    }
  });

  it("throws on an unknown tool", async () => {
    const registry = new ToolRegistry();
    const { ctx } = makeContext();
    await expect(registry.call("nope", {}, ctx)).rejects.toThrow(/Unknown tool/);
  });
});

describe("search_vault_memory", () => {
  let registry: ToolRegistry;
  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("returns query-scoped results after indexing", async () => {
    const { engine, ctx } = makeContext({
      "Notes/rag.md": "# RAG\nThe indexing pipeline chunks markdown for retrieval.",
    });
    await engine.reindex();
    const out = await registry.call("search_vault_memory", { query: "indexing retrieval" }, ctx);
    expect(out).toContain("Notes/rag.md");
    expect(out).toMatch(/result/i);
  });

  it("reports no results cleanly", async () => {
    const { engine, ctx } = makeContext({ "Notes/a.md": "# A\nalpha" });
    await engine.reindex();
    const out = await registry.call("search_vault_memory", { query: "zzzznomatch" }, ctx);
    expect(out).toMatch(/no results/i);
  });

  it("rejects a missing query", async () => {
    const { ctx } = makeContext();
    await expect(registry.call("search_vault_memory", {}, ctx)).rejects.toThrow(/query/);
  });
});

describe("add_memory", () => {
  it("always proposes to the inbox over the network, never a direct write", async () => {
    // Even with direct writes enabled in settings, the tool must go to the inbox.
    const { adapter, ctx } = makeContext({}, { allowDirectWrites: true });
    const registry = new ToolRegistry();
    const out = await registry.call(
      "add_memory",
      { content: "Prefer local JSON index.", type: "decision", project: "Demo" },
      ctx,
    );
    expect(out).toContain("Claude Code/Memory/Inbox/pending-memory.md");
    const inbox = await adapter.read("Claude Code/Memory/Inbox/pending-memory.md");
    expect(inbox).toContain("Prefer local JSON index.");
    // Nothing was written to a global/project memory file directly.
    expect(await adapter.exists("Claude Code/Memory/Global/profile.md")).toBe(false);
  });

  it("rejects empty content", async () => {
    const { ctx } = makeContext();
    const registry = new ToolRegistry();
    await expect(registry.call("add_memory", { content: "" }, ctx)).rejects.toThrow();
  });

  it("coerces an unknown type to 'note'", async () => {
    const { adapter, ctx } = makeContext();
    const registry = new ToolRegistry();
    await registry.call("add_memory", { content: "hi", type: "bogus" }, ctx);
    const inbox = await adapter.read("Claude Code/Memory/Inbox/pending-memory.md");
    expect(inbox).toContain("Type: note");
  });
});

describe("context tools", () => {
  it("get_project_context returns concatenated project memory", async () => {
    const { engine, ctx } = makeContext();
    const registry = new ToolRegistry();
    await engine.ensureScaffold();
    await engine.createProject("Demo");
    const out = await registry.call("get_project_context", { project: "Demo" }, ctx);
    expect(out).toContain("Overview");
  });

  it("get_global_context and list_projects work on a fresh scaffold", async () => {
    const { engine, ctx } = makeContext();
    const registry = new ToolRegistry();
    await engine.ensureScaffold();
    await engine.createProject("Demo");
    expect(await registry.call("get_global_context", {}, ctx)).toContain("Profile");
    expect(await registry.call("list_projects", {}, ctx)).toContain("Demo");
  });
});

describe("reindex_vault rate limiting", () => {
  it("rejects a second reindex within the cooldown window", async () => {
    const { engine } = makeContext({ "Notes/a.md": "# A\nalpha" });
    // Use a real (advancing but tiny) clock so the two calls land in the cooldown.
    const ctx: ToolContext = {
      engine,
      settings: { ...DEFAULT_SETTINGS },
      logger: NULL_LOGGER,
      clock: () => 5,
      rateLimiter: new RateLimiter(() => 5), // same instant → cooldown always active
    };
    const registry = new ToolRegistry();
    const first = await registry.call("reindex_vault", {}, ctx);
    expect(first).toMatch(/Reindexed/);
    await expect(registry.call("reindex_vault", {}, ctx)).rejects.toThrow(/Rate limited/);
  });

  it("refuses when indexing is disabled", async () => {
    const { ctx } = makeContext({}, { indexingEnabled: false });
    const registry = new ToolRegistry();
    await expect(registry.call("reindex_vault", {}, ctx)).rejects.toThrow(/disabled/i);
  });
});

describe("RateLimiter.enforceWindow", () => {
  it("permits up to maxCalls then blocks within the window", () => {
    const limiter = new RateLimiter(() => 1000); // frozen clock: one window
    for (let i = 0; i < 3; i++) limiter.enforceWindow("k", 3, 60_000);
    expect(() => limiter.enforceWindow("k", 3, 60_000)).toThrow(/too many/i);
  });

  it("forgets calls that fall outside the window", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    limiter.enforceWindow("k", 1, 1000);
    now = 2000; // advance past the window
    expect(() => limiter.enforceWindow("k", 1, 1000)).not.toThrow();
  });

  it("get_note_context returns the full indexed passages of a note", async () => {
    const { engine, ctx } = makeContext({
      "Notes/rag.md": "# RAG\n\nThe indexing pipeline chunks markdown for retrieval.\n\n## Vectors\n\nCosine similarity ranks chunks.",
    });
    await engine.reindex();
    const registry = new ToolRegistry();
    const out = await registry.call("get_note_context", { path: "Notes/rag.md" }, ctx);
    expect(out).toContain("Notes/rag.md");
    expect(out).toContain("indexing pipeline chunks markdown");
    expect(out).toContain("Cosine similarity ranks chunks");
    expect(out).toMatch(/\[Line/); // carries line-range labels
  });

  it("get_note_context refuses a note that is not indexed", async () => {
    // An excluded note has no chunks, so it must be refused (no general file-read).
    const { engine, ctx } = makeContext(
      { "Secret/keys.md": "# Keys\n\nsensitive content" },
      { excludedFolders: ["Secret"] },
    );
    await engine.reindex();
    const registry = new ToolRegistry();
    await expect(
      registry.call("get_note_context", { path: "Secret/keys.md" }, ctx),
    ).rejects.toThrow(/not indexed/i);
  });

  it("get_note_context truncates past maxChars and says so", async () => {
    const long = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\n${"word ".repeat(200)}`).join("\n\n");
    const { engine, ctx } = makeContext({ "Notes/big.md": `# Big\n\n${long}` });
    await engine.reindex();
    const registry = new ToolRegistry();
    const out = await registry.call("get_note_context", { path: "Notes/big.md", maxChars: 1500 }, ctx);
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(3000);
  });

  it("get_note_context clips a single oversized passage to maxChars (hard ceiling)", async () => {
    // One unbroken paragraph → one chunk larger than maxChars. It must still be
    // capped and flagged, not returned in full.
    const oneHugeParagraph = "word ".repeat(6000); // ~30k chars, no blank lines
    const { engine, ctx } = makeContext({ "Notes/wall.md": `# Wall\n\n${oneHugeParagraph}` });
    await engine.reindex();
    const registry = new ToolRegistry();
    const maxChars = 2000;
    const out = await registry.call("get_note_context", { path: "Notes/wall.md", maxChars }, ctx);
    expect(out).toContain("truncated");
    // Body is clipped to maxChars; header + footer are small bounded metadata.
    expect(out.length).toBeLessThan(maxChars + 300);
  });

  it("add_memory de-duplicates an identical proposal and says so", async () => {
    const { ctx } = makeContext();
    const registry = new ToolRegistry();
    const args = { content: "Prefer pnpm over npm for this repo.", type: "preference" };
    const first = await registry.call("add_memory", args, ctx);
    expect(first).toMatch(/appended/i);
    const second = await registry.call("add_memory", args, ctx);
    expect(second).toMatch(/already pending/i);
    expect(second).not.toMatch(/appended/i);
  });

  it("floods of add_memory are eventually rate limited over the network path", async () => {
    // Frozen clock keeps every call inside one window so the cap is hit.
    const adapter = new InMemoryVaultAdapter("v", {});
    const settings = { ...DEFAULT_SETTINGS };
    const engine = new EngramEngine(adapter, settings, NULL_LOGGER, () => 0);
    const ctx: ToolContext = {
      engine,
      settings,
      logger: NULL_LOGGER,
      clock: () => 0,
      rateLimiter: new RateLimiter(() => 0),
    };
    const registry = new ToolRegistry();
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await registry.call("add_memory", { content: `m${i}` }, ctx);
      } catch (err) {
        blocked = /rate limited/i.test((err as Error).message);
        break;
      }
    }
    expect(blocked).toBe(true);
  });
});
