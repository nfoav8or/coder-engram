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

  it("bounds the summary of a note built from long unbroken lines", async () => {
    // Units are split on lines first, and a line with no sentence terminator
    // stays one unit however long it is — pasted JSON, base64, a wide table
    // row. Bounding by sentence COUNT alone lets the tool whose whole purpose
    // is cheap context return more than a full note read.
    // Each line is ONE token with no whitespace and no sentence terminator, so
    // it stays a single long unit (chunking hard-slices it, but the pieces stay
    // far larger than a sentence). The trailing index keeps units distinct —
    // summary units are de-duplicated, so identical filler would collapse.
    const blob = (i: number) => "q".repeat(1_500) + `end${i}`;
    const note = `# Blobs\n\n${Array.from({ length: 12 }, (_, i) => blob(i)).join("\n")}`;
    const { engine, ctx } = makeContext({ "Notes/blob.md": note });
    await engine.reindex();
    const registry = new ToolRegistry();
    // Ask for enough sentences that the selection exceeds the char cap even
    // though chunking now bounds each unit — the cap is what holds the line.
    const out = await registry.call("summarize_note", { path: "Notes/blob.md", maxSentences: 20 }, ctx);
    expect(out.length).toBeLessThan(5_000);
    expect(out).toContain("truncated");

    // With few sentences the output is simply small, no clipping needed.
    const short = await registry.call("summarize_note", { path: "Notes/blob.md", maxSentences: 2 }, ctx);
    expect(short.length).toBeLessThan(5_000);
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
