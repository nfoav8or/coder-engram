/**
 * A minimal trailing-edge debounce with a `cancel`.
 * Used to batch file-change reindex requests so a burst of edits triggers a
 * single index refresh instead of one per keystroke.
 */

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: A | null = null;

  const invoke = (): void => {
    if (pendingArgs) {
      const args = pendingArgs;
      pendingArgs = null;
      fn(...args);
    }
  };

  const debounced = ((...args: A): void => {
    pendingArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      invoke();
    }, waitMs);
  }) as Debounced<A>;

  debounced.cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    pendingArgs = null;
  };

  return debounced;
}
