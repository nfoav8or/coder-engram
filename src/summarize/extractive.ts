/**
 * extractive — honest, dependency-free extractive summarization.
 *
 * There is no text-generation backend in this plugin (only embeddings), so a
 * summary here is never invented prose: it is a selection of the note's OWN
 * sentences. Two ranking backends share one selection routine:
 *
 *   - lexical  — frequency centrality (Luhn/centroid): sentences built from the
 *     note's most characteristic words rank highest. Always available, offline.
 *   - embedding — when sentence vectors are supplied, sentences closest to the
 *     note's embedding centroid rank highest, and Maximal Marginal Relevance
 *     (MMR) trades relevance against redundancy so near-duplicate sentences
 *     (common when overlapping chunks are the source) don't crowd the summary.
 *
 * Selected sentences are always returned in their original document order.
 */

import { cosineSimilarity } from "../embeddings/embedding-provider";

export type SummaryMethod = "embedding" | "lexical";

export interface ExtractiveSummary {
  /** The chosen sentences, verbatim, in original order. */
  sentences: string[];
  /** Indices into the input units, in original order. */
  indices: number[];
  /** Which ranking backend produced the selection. */
  method: SummaryMethod;
  /** How many candidate units the note yielded. */
  totalUnits: number;
}

// A small English stop-word set — enough to stop function words from dominating
// the frequency centrality without pulling in a dependency.
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "of", "to",
  "in", "on", "at", "by", "is", "are", "was", "were", "be", "been", "being",
  "it", "its", "this", "that", "these", "those", "as", "with", "from", "into",
  "so", "such", "not", "no", "do", "does", "did", "can", "will", "would",
  "should", "may", "might", "must", "have", "has", "had", "we", "you", "they",
  "he", "she", "i", "our", "your", "their", "them", "us", "which", "who", "what",
  "when", "where", "how", "why", "there", "here", "than", "too", "very", "just",
]);

// Common abbreviations whose period is not a sentence boundary. A run of
// single letters ("U.S.", "e.g.") is caught separately, below — this list is
// only for multi-letter abbreviations.
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "approx",
  "no", "vol", "fig", "dept", "gov", "rev", "capt", "gen", "col", "lt", "sgt",
]);

/**
 * True if `part` — one `[^.!?]+(?:[.!?]+|$)` split fragment ending in a `.` —
 * ends on an abbreviation rather than a real sentence boundary, so it should
 * be merged with the next fragment instead of standing alone.
 */
function endsWithAbbreviation(part: string): boolean {
  const trimmed = part.trimEnd();
  if (!trimmed.endsWith(".")) return false;
  const word = trimmed.slice(0, -1).match(/[A-Za-z]+$/)?.[0];
  if (!word) return false;
  // A single letter is an initial or the first/second letter of a
  // dotted-abbreviation run ("U.S.", "e.g.") — each dot in the run splits
  // its own single-letter fragment, so this rule alone reassembles them.
  return word.length === 1 || ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Split Markdown text into sentence-like units. Lines are separated first (so a
 * heading or list item is its own unit), then each line is split on sentence
 * punctuation. Common Markdown markers (heading `#`, list `-*+`, quote `>`) are
 * stripped from the front so they don't pollute the text. No lookbehind is used
 * (keeps the compiled target broad).
 *
 * A naive split on `.!?` treats every abbreviation's period as a sentence
 * boundary ("Dr. Smith" -> "Dr." + " Smith"), which would surface fragments
 * like "S." as standalone "sentences" — a real failure of the module's own
 * promise that a summary is only ever the note's own sentences. Fragments
 * ending on a likely abbreviation are merged back into the next fragment.
 */
export function splitIntoSentences(text: string): string[] {
  const units: string[] = [];
  for (const rawLine of text.split(/\r?\n+/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const cleaned = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^>\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .trim();
    if (!cleaned) continue;
    const rawParts = cleaned.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [cleaned];
    let buffer = "";
    for (let i = 0; i < rawParts.length; i++) {
      buffer += rawParts[i];
      if (i < rawParts.length - 1 && endsWithAbbreviation(rawParts[i])) continue;
      const s = buffer.trim();
      if (s.length >= 2) units.push(s);
      buffer = "";
    }
  }
  return units;
}

/** A word: letters/numbers in any script, with apostrophes and hyphens kept
 * inside a token (this tokenizer's deliberate difference from retrieval's —
 * see ARCHITECTURE.md). The previous ASCII-only class produced zero tokens for
 * a non-Latin-script note, so every unit scored 0 and the "most representative
 * sentences" silently degraded to the first N in document order. NFC first so
 * composed and decomposed spellings of one word count as one word. */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;

function tokenize(unit: string): string[] {
  const tokens = unit.normalize("NFC").toLowerCase().match(WORD) ?? [];
  return tokens.filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/**
 * Frequency-centrality score per unit (Luhn-style). A unit scores by the mean
 * corpus frequency of its content words, so sentences made of the note's most
 * characteristic words rank highest. Content-word-free units score 0.
 */
export function scoreLexical(units: string[]): number[] {
  const freq = new Map<string, number>();
  const perUnit: string[][] = [];
  for (const unit of units) {
    const tokens = tokenize(unit);
    perUnit.push(tokens);
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return perUnit.map((tokens) => {
    if (tokens.length === 0) return 0;
    let sum = 0;
    for (const t of tokens) sum += freq.get(t) ?? 0;
    return sum / tokens.length;
  });
}

/**
 * Centrality score per vector: cosine similarity to the mean (centroid) vector.
 * Units closest to the document centroid are the most representative.
 */
export function scoreByCentroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const centroid = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) centroid[i] += v[i] ?? 0;
  }
  for (let i = 0; i < dim; i++) centroid[i] /= vectors.length;
  return vectors.map((v) => cosineSimilarity(v, centroid));
}

/**
 * Select up to `k` unit indices, returned in ascending (original) order.
 *
 * With `vectors`, selection is greedy MMR: each pick maximizes
 * `lambda*score - (1-lambda)*maxSimilarityToAlreadyPicked`, penalizing
 * redundancy. Without vectors it is a straight top-k by score (ties broken by
 * earlier position).
 */
export function selectSentences(
  units: string[],
  scores: number[],
  k: number,
  opts: { vectors?: number[][]; lambda?: number } = {},
): number[] {
  const n = units.length;
  const want = Math.max(0, Math.min(Math.trunc(k), n));
  if (want === 0) return [];

  const vectors = opts.vectors;
  if (!vectors || vectors.length !== n) {
    const ranked = scores
      .map((s, i) => ({ s, i }))
      .sort((a, b) => (b.s - a.s) || (a.i - b.i))
      .slice(0, want)
      .map((r) => r.i);
    return ranked.sort((a, b) => a - b);
  }

  const lambda = opts.lambda ?? 0.7;
  const selected: number[] = [];
  const remaining = new Set<number>(units.map((_, i) => i));
  while (selected.length < want && remaining.size > 0) {
    let best = -1;
    let bestVal = -Infinity;
    for (const i of remaining) {
      let maxSim = 0;
      for (const j of selected) {
        const sim = cosineSimilarity(vectors[i], vectors[j]);
        if (sim > maxSim) maxSim = sim;
      }
      const val = lambda * scores[i] - (1 - lambda) * maxSim;
      if (val > bestVal || (val === bestVal && (best < 0 || i < best))) {
        bestVal = val;
        best = i;
      }
    }
    if (best < 0) break;
    selected.push(best);
    remaining.delete(best);
  }
  return selected.sort((a, b) => a - b);
}

/**
 * Produce an extractive summary from pre-split units. Uses the embedding
 * backend when aligned per-unit `vectors` are supplied; otherwise lexical.
 */
export function extractiveSummary(input: {
  units: string[];
  maxSentences: number;
  vectors?: number[][];
}): ExtractiveSummary {
  const { units, maxSentences } = input;
  const useEmbedding = !!input.vectors && input.vectors.length === units.length && units.length > 0;
  const method: SummaryMethod = useEmbedding ? "embedding" : "lexical";
  const scores = useEmbedding ? scoreByCentroid(input.vectors!) : scoreLexical(units);
  const indices = selectSentences(units, scores, maxSentences, {
    vectors: useEmbedding ? input.vectors : undefined,
  });
  return {
    sentences: indices.map((i) => units[i]),
    indices,
    method,
    totalUnits: units.length,
  };
}
