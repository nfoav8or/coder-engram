/**
 * withTimeout — bound how long we WAIT for work that may never settle.
 *
 * Size caps bound how much a file can cost; they say nothing about how long it
 * takes. Work that hangs rather than fails throws nothing for a `catch` to see:
 * the await simply never settles and whatever was waiting on it — a refresh, a
 * query — waits forever. That failure mode has appeared twice already, in PDF
 * parsing and in `requestUrl`, so the guard lives here rather than being
 * written out a third time.
 *
 * The underlying work is ABANDONED, not cancelled — neither pdf.js nor a
 * companion plugin's API offers cancellation — so this bounds the wait, not the
 * worker. The orphaned promise resolves into the void and is collected.
 *
 * This module also owns the plugin's two timer primitives, `setTimer` and
 * `clearTimer`. Obsidian asks plugins to call `window.setTimeout` rather than
 * the bare global so a timer belongs to the window that scheduled it and dies
 * with a popout window instead of firing into a detached document. The core and
 * server layers must also run under Node, where `window` does not exist and
 * every unit test lives, so calling `window.*` directly would mean shimming a
 * browser global into the test environment and giving the pure core a host
 * dependency. Resolving the host per call satisfies both: real windows get
 * window-owned timers, Node gets the global, and nothing imports a host API.
 */

/**
 * An opaque timer handle. `window.setTimeout` returns a number and Node's
 * returns a `Timeout` object, so the union is the only type both satisfy —
 * which is precisely why callers must clear through `clearTimer` rather than
 * either global.
 */
export type TimerHandle = ReturnType<typeof globalThis.setTimeout> | number;

/**
 * Schedule `fn` after `ms`, owned by the current window when there is one.
 *
 * The Node branch reaches the global as `globalThis.setTimeout` rather than the
 * bare identifier deliberately. A bare call is what Obsidian's review scanner
 * flags, so writing it here would trade nine warnings for two while changing
 * nothing about behaviour — and the qualified form says which global is meant,
 * which is the honest reading of a deliberate fallback anyway.
 */
export function setTimer(fn: () => void, ms: number): TimerHandle {
  return typeof window === "undefined" ? globalThis.setTimeout(fn, ms) : window.setTimeout(fn, ms);
}

/** Cancel a handle from {@link setTimer}. A null/undefined handle is a no-op. */
export function clearTimer(handle: TimerHandle | null | undefined): void {
  if (handle === null || handle === undefined) return;
  if (typeof window === "undefined") {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  } else {
    window.clearTimeout(handle as number);
  }
}

/** Reject if `work` has not settled within `ms`. */
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: TimerHandle | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimer(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimer(timer);
  }
}
