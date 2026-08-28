import { describe, it, expect, vi } from "vitest";
import { clearTimer, setTimer, withTimeout } from "../src/utils/timeout";

/**
 * The guard itself is finally testable. Both places that need it — PDF parsing
 * and a companion plugin's OCR call — live in files that import `obsidian`,
 * which ships types with no runtime, so neither could ever be unit tested. The
 * shared helper is pure, so the behaviour every caller depends on is pinned
 * here rather than only in the e2e run.
 */

describe("withTimeout", () => {
  it("resolves with the work's value when it settles in time", async () => {
    await expect(withTimeout(Promise.resolve("done"), 1000, "fast")).resolves.toBe("done");
  });

  it("passes a rejection through unchanged", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "failing")).rejects.toThrow(
      /boom/,
    );
  });

  it("rejects work that never settles, naming what hung", async () => {
    // The case that matters: a hang throws nothing, so without this the await
    // simply never returns and the refresh waiting on it never finishes.
    const never = new Promise<string>(() => {
      /* deliberately never settles */
    });
    await expect(withTimeout(never, 10, "Papers/stuck.pdf")).rejects.toThrow(
      /Timed out after 10ms: Papers\/stuck\.pdf/,
    );
  });

  it("clears its timer once the work settles", async () => {
    // Otherwise every bounded call leaves a pending timer behind — thousands of
    // them across a vault-wide refresh, each holding its closure alive.
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const before = clear.mock.calls.length;
    await withTimeout(Promise.resolve(1), 60_000, "x");
    expect(clear.mock.calls.length).toBeGreaterThan(before);
    clear.mockRestore();
  });
});

describe("setTimer / clearTimer", () => {
  it("uses the window's timers when a window exists, and the global otherwise", async () => {
    // Obsidian wants a timer owned by the window that scheduled it, so it dies
    // with a popout instead of firing into a detached document. The core and
    // server layers also run under Node — which is where these tests run — so
    // the helper resolves the host per call instead of naming `window`
    // directly, which would need a browser global shimmed into the test env.
    expect(typeof globalThis.window).toBe("undefined");

    await new Promise<void>((resolve) => setTimer(resolve, 0));

    const windowSetTimeout = vi.fn((fn: () => void) => {
      fn();
      return 7;
    });
    const windowClearTimeout = vi.fn();
    (globalThis as { window?: unknown }).window = {
      setTimeout: windowSetTimeout,
      clearTimeout: windowClearTimeout,
    };
    try {
      const handle = setTimer(() => undefined, 0);
      expect(windowSetTimeout).toHaveBeenCalledTimes(1);
      expect(handle).toBe(7);
      clearTimer(handle);
      expect(windowClearTimeout).toHaveBeenCalledWith(7);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("treats a null or undefined handle as a no-op", () => {
    expect(() => clearTimer(null)).not.toThrow();
    expect(() => clearTimer(undefined)).not.toThrow();
  });
});
