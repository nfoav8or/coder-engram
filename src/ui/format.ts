/**
 * Small pure presentation helpers for the UI layer. No `obsidian` import, so
 * these stay unit-testable in the node test environment.
 */

/**
 * Format a chunk's 0-based inclusive line span as a human 1-based label.
 * A single line reads "Line 5"; a span reads "Lines 5–8".
 */
export function formatLineRange(startLine: number, endLine: number): string {
  const start = startLine + 1;
  const end = Math.max(start, endLine + 1);
  return start === end ? `Line ${start}` : `Lines ${start}–${end}`;
}
