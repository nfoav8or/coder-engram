/**
 * conflict — spotting that a proposal covers ground an existing memory already
 * covers, at the moment it is proposed.
 *
 * `add_memory` checks for DUPLICATES: an exact restatement is absorbed. It has
 * never checked for anything weaker. So an agent proposing "we moved to
 * Postgres" when memory says "we chose SQLite" got both stored, silently, and
 * retrieval later returned the pair with nothing to say which was current — the
 * accumulation of contradictions that made superseding necessary in the first
 * place.
 *
 * What this does is deliberately narrower than its name suggests, and the
 * wording everywhere reflects that: it finds the existing memory with the
 * highest lexical OVERLAP and reports it. It does not decide that two memories
 * disagree — no offline, dependency-free check can — it puts the candidate in
 * front of the agent and the reviewer, who can. The action it enables is
 * `supersedes`: the agent re-proposes naming what it replaces, and a person
 * approves the replacement.
 *
 * Pure and offline. It runs inside a write path, so it must not embed, must not
 * reach the network, and must never fail a proposal.
 */

import { IndexedChunk } from "../indexing/index-manager";
import { tokenize, tokenizeChunk } from "../retrieval/ranking";

/**
 * Minimum share of the proposal's own distinct terms that must also appear in
 * an existing memory before it is worth mentioning.
 *
 * Containment, not Jaccard: a two-line proposal genuinely about the same
 * decision as a long-standing memory should match it, and Jaccard punishes that
 * pairing for the length difference alone. 0.6 asks that most of what the
 * proposal is *made of* is already there, which is what "we have something on
 * this" means. Lower values surfaced any memory sharing a project's vocabulary.
 */
export const SIMILARITY_MIN_OVERLAP = 0.6;

/** Proposals shorter than this have too few terms for a ratio to mean anything. */
const MIN_TERMS = 4;

/** The existing memory a proposal most overlaps with. */
export interface SimilarMemory {
  /** `<path>#<heading>` — the exact shape `supersedes` takes. */
  ref: string;
  /** Share of the proposal's distinct terms found in that memory (0–1). */
  overlap: number;
}

/**
 * The strongest overlap between `content` and any of `candidates`, or `null`
 * when nothing clears {@link SIMILARITY_MIN_OVERLAP}.
 *
 * `candidates` are retrieval results already scoped to the memory root by the
 * caller; this function only scores them, so it stays testable without an index.
 */
export function findSimilarMemory(
  content: string,
  candidates: IndexedChunk[],
): SimilarMemory | null {
  const terms = new Set(tokenize(content));
  if (terms.size < MIN_TERMS) return null;

  let best: SimilarMemory | null = null;
  for (const chunk of candidates) {
    const have = new Set(tokenizeChunk(chunk));
    let hits = 0;
    for (const t of terms) if (have.has(t)) hits++;
    const overlap = hits / terms.size;
    if (overlap < SIMILARITY_MIN_OVERLAP) continue;
    if (!best || overlap > best.overlap) {
      best = { ref: `${chunk.notePath}#${chunk.heading}`, overlap };
    }
  }
  return best;
}
