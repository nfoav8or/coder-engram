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
 */

/** Reject if `work` has not settled within `ms`. */
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
