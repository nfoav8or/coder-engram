/**
 * decay — ageing memory so a settled fact stops outranking a recent one.
 *
 * Every memory used to be equally true forever. A decision from eighteen months
 * ago outranked last week's on term frequency alone, and recency existed only as
 * a FILTER (`sinceDays`), which is all-or-nothing: it either hides old memory
 * outright or ignores age completely.
 *
 * This is a ranking signal instead, and an opt-in one — it changes scoring
 * semantics, so it defaults to off. Two properties matter more than the curve:
 *
 *   - **It applies to memory only.** Ordinary notes are documents, not claims
 *     that go stale, and decaying the whole vault would change what search
 *     means for every user who wanted this for their memory.
 *   - **It is floored.** An old memory is down-weighted, never unreachable. A
 *     memory you cannot retrieve is a memory you have lost, and this feature
 *     exists to order memory, not to delete it.
 */

import { IndexedChunk } from "../indexing/index-manager";
import { MS_PER_DAY } from "../utils/format";

/**
 * Weakest multiplier any memory can decay to.
 *
 * Chosen so age reorders results but never removes them: at the floor a memory
 * still outranks anything it beats by more than 4× on relevance, which is the
 * difference between "older, so lower" and "old, so gone".
 */
export const MIN_DECAY = 0.25;

/**
 * When a memory was RECORDED, in ms — from the timestamp `formatAppliedBlock`
 * writes into its heading (`## Decision — 2026-07-03 14:22 · anchor`), falling
 * back to the file's mtime.
 *
 * The heading is what makes this per-memory rather than per-file. Falling back
 * to mtime alone would date every memory in a file by its last edit, so adding
 * one decision would make every older decision beside it look new again —
 * decay that resets itself is worse than none, because it looks like it works.
 */
export function memoryRecordedAt(chunk: IndexedChunk): number {
  const m = /—\s(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2})/.exec(chunk.heading);
  if (!m) return chunk.mtime;
  // Local time, matching `formatTimestamp`, which is what wrote it.
  const at = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  ).getTime();
  return Number.isFinite(at) ? at : chunk.mtime;
}

/**
 * Exponential decay by half-life, floored at {@link MIN_DECAY}. A half-life of
 * 0 (or anything non-positive) means the feature is off and returns 1.
 *
 * A memory dated in the future scores 1 rather than more than 1: clock skew and
 * a hand-typed heading both produce those, and letting them exceed 1 would make
 * a wrong date a way to win every ranking.
 */
export function decayFactor(ageMs: number, halfLifeDays: number): number {
  if (!(halfLifeDays > 0)) return 1;
  if (!(ageMs > 0)) return 1;
  return Math.max(MIN_DECAY, 0.5 ** (ageMs / MS_PER_DAY / halfLifeDays));
}

/**
 * Re-weight and re-order results by how old their memory is.
 *
 * Runs on the ranked list, not on the corpus: the retriever's scores (BM25, or
 * a fused rank) are comparable within one result set, and decaying the corpus
 * first would move the statistics every score is computed against.
 */
export function applyMemoryDecay<T extends { chunk: IndexedChunk; score: number }>(
  results: T[],
  now: number,
  halfLifeDays: number,
  isMemory: (notePath: string) => boolean,
): T[] {
  if (!(halfLifeDays > 0) || results.length === 0) return results;
  // Most searches return no memory at all, and once the setting is on that case
  // would otherwise build and discard a full copy of the page on every query.
  if (!results.some((r) => isMemory(r.chunk.notePath))) return results;
  let changed = false;
  const weighted = results.map((r) => {
    if (!isMemory(r.chunk.notePath)) return r;
    const factor = decayFactor(now - memoryRecordedAt(r.chunk), halfLifeDays);
    if (factor === 1) return r;
    changed = true;
    return { ...r, score: r.score * factor };
  });
  // Same array back when nothing aged, so a vault with no memory in its results
  // pays nothing for having the setting on.
  if (!changed) return results;
  return weighted.sort((a, b) => b.score - a.score);
}
