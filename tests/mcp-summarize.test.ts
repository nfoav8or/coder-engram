import { describe, it, expect } from "vitest";
import { EngramEngine } from "../src/engine";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { DEFAULT_SETTINGS, EngramSettings } from "../src/settings/settings";
import { NULL_LOGGER } from "../src/utils/logger";
import { ToolRegistry, ToolContext, RateLimiter } from "../src/server/mcp-tools";

const NOTE = `# Alpha Note
The indexing pipeline chunks markdown notes for retrieval.
Embeddings power the vector retriever when a provider is set.
The review inbox keeps human-in-the-loop control over memory.`;

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
    rateLimiter: new RateLimiter(() => 0), // frozen clock: one rate-limit window
  };
  return { adapter, engine, ctx };
}

describe("summarize_note tool", () => {
  it("is advertised via tools/list", () => {
    const names = new ToolRegistry().list().map((t) => t.name);
    expect(names).toContain("summarize_note");
  });

  it("returns an extractive summary for an indexed note", async () => {
    const { engine, ctx } = makeContext({ "Notes/a.md": NOTE });
    await engine.reindex();
    const registry = new ToolRegistry();
    const out = await registry.call("summarize_note", { path: "Notes/a.md" }, ctx);
    expect(out).toMatch(/^Extractive summary of Notes\/a\.md/);
  });

  it("throws for an unindexed path", async () => {
    const { engine, ctx } = makeContext({ "Notes/a.md": NOTE });
    await engine.reindex();
    const registry = new ToolRegistry();
    await expect(
      registry.call("summarize_note", { path: "Notes/missing.md" }, ctx),
    ).rejects.toThrow();
  });

  it("throws when path is missing", async () => {
    const { engine, ctx } = makeContext({ "Notes/a.md": NOTE });
    await engine.reindex();
    const registry = new ToolRegistry();
    await expect(registry.call("summarize_note", {}, ctx)).rejects.toThrow(/path/);
  });

  it("rate limits after 30 calls in the same minute", async () => {
    const { engine, ctx } = makeContext({ "Notes/a.md": NOTE });
    await engine.reindex();
    const registry = new ToolRegistry();
    for (let i = 0; i < 30; i++) {
      // eslint-disable-next-line no-await-in-loop
      await registry.call("summarize_note", { path: "Notes/a.md" }, ctx);
    }
    await expect(
      registry.call("summarize_note", { path: "Notes/a.md" }, ctx),
    ).rejects.toThrow(/rate limited/i);
  });
});
