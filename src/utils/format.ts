/**
 * Small pure presentation helpers shared by the UI and the MCP server. No
 * `obsidian` import, so they stay unit-testable in the node test environment.
 */

/**
/** Milliseconds in a day. One definition, so day-math cannot drift between
 * the tools' `sinceDays` windows and memory ageing's half-life. */
export const MS_PER_DAY = 86_400_000;

/**
 * A single line reads "Line 5"; a span reads "Lines 5–8".
 */
export function formatLineRange(startLine: number, endLine: number): string {
  const start = startLine + 1;
  const end = Math.max(start, endLine + 1);
  return start === end ? `Line ${start}` : `Lines ${start}–${end}`;
}

/**
 * UTC day (`YYYY-MM-DD`) of an epoch-ms mtime — the staleness signal shown
 * next to a search hit (same as the MCP output). "" for a non-finite mtime.
 */
export function formatModifiedDate(mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs)) return "";
  return new Date(mtimeMs).toISOString().slice(0, 10);
}
