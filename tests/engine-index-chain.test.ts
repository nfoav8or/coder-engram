import { describe, it, expect } from "vitest";
import { EngramEngine } from "../src/engine";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import { NULL_LOGGER } from "../src/utils/logger";

/**
 * `IndexManager.build`/`refresh` yield to the event loop mid-pass, and the
 * engine's scan awaits vault I/O, so two callers (auto-index debounce, a
 * settings-triggered refresh, the `reindex_vault` tool) can arrive while a
 * pass is in flight. Unserialized, both would scan and then mutate one index
 * concurrently. The engine chains them like it already chains embedding passes.
 */
describe("engine index passes are serialized", () => {
  it("never runs two refresh/reindex bodies at once", async () => {
    const adapter = new InMemoryVaultAdapter("v", { "Notes/a.md": "# A\nalpha", "Notes/b.md": "# B\nbeta" });
    const engine = new EngramEngine(adapter, { ...DEFAULT_SETTINGS }, NULL_LOGGER);
    await engine.reindex();

    // Wrap the private pass bodies on the instance so `this.doX()` hits the
    // counter; the public methods stay the real, chained ones under test.
    const inner = engine as unknown as { doRefresh: () => Promise<unknown>; doReindex: () => Promise<unknown> };
    let active = 0;
    let peak = 0;
    const wrap = <T>(fn: () => Promise<T>) => async () => {
      active++;
      peak = Math.max(peak, active);
      try {
        return await fn();
      } finally {
        active--;
      }
    };
    inner.doRefresh = wrap(inner.doRefresh.bind(engine));
    inner.doReindex = wrap(inner.doReindex.bind(engine));

    adapter.touch("Notes/a.md", "# A\nalpha edited");
    await Promise.all([engine.refresh(), engine.reindex(), engine.refresh()]);
    expect(peak).toBe(1);
    expect(engine.getIndexStats().chunkCount).toBeGreaterThan(0);
  });
});
