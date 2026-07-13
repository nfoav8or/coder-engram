/**
 * lexical-retriever — BM25 ranking over index chunks. No API keys, works
 * offline, and is the default retrieval mode for M1.
 *
 * BM25 is computed over the (already filtered) candidate set so that IDF
 * reflects the corpus the user is actually searching. A small heading-match
 * boost nudges chunks whose heading contains a query term.
 */

import { IndexedChunk } from "../indexing/index-manager";
import {
  Retriever,
  RetrievalQuery,
  RetrievalResult,
  RetrievalFilters,
  DEFAULT_LIMIT,
} from "./retriever";
import { tokenize, tokenizeChunk, applyFilters, buildSnippet, diversifyByNote } from "./ranking";

const K1 = 1.5;
const B = 0.75;
const HEADING_BOOST = 1.15;
/**
 * Score credited for a query term found only in a chunk's FIELD terms (note
 * filename, frontmatter aliases, ancestor headings) — text that names the note
 * but is absent from the chunk body, which plain BM25 therefore scores 0: a
 * query for "Quartzine Protocol" never ranked `Quartzine Protocol.md` unless
 * the body repeated the words. 1.0 × idf equals the BM25 score of ONE
 * occurrence in an AVERAGE-length body — so a field-only match can outrank a
 * single mention buried in a long chunk (deliberate: a note named for the
 * query is at least that relevant) but loses to any stronger body match.
 * Note: df counts body terms only, so a name-only term scores at maximum idf
 * — accepted; folding fields into df isn't worth the complexity yet.
 */
const FIELD_MATCH_WEIGHT = 1.0;

export interface LexicalRetrieverOptions {
  projectRootResolver?: (project: string) => string;
}

/**
 * Corpus-invariant BM25 statistics for one chunk set: per-chunk term frequencies,
 * document lengths, per-chunk heading terms, and the global document-frequency map
 * + average doc length. These depend only on the chunks, not the query, so they
 * are computed once per corpus and reused across queries.
 */
interface CorpusStats {
  chunks: IndexedChunk[];
  tf: Map<string, number>[];
  headingTerms: Set<string>[];
  /** Filename + alias + ancestor-heading tokens (see FIELD_MATCH_WEIGHT). The
   * chunk's OWN heading line is part of its text, so it needs no field entry. */
  fieldTerms: Set<string>[];
  docLengths: number[];
  df: Map<string, number>;
  avgdl: number;
  N: number;
}

function fieldTermsFor(chunk: IndexedChunk): Set<string> {
  // Strip whatever the real extension is, not just .md: attachments are
  // indexed too, and "pdf"/"docx" as a near-zero-df field term would score
  // max IDF on every chunk of every such file, drowning body matches.
  const basename = chunk.notePath
    .slice(chunk.notePath.lastIndexOf("/") + 1)
    .replace(/\.[a-z0-9]+$/i, "");
  const field = new Set(tokenize(basename));
  for (const alias of chunk.aliases) for (const t of tokenize(alias)) field.add(t);
  for (const h of chunk.headingPath) for (const t of tokenize(h)) field.add(t);
  return field;
}

/** Per-chunk statistics — corpus-INDEPENDENT, so they survive any filtering. */
interface ChunkStats {
  tf: Map<string, number>;
  docLength: number;
  headingTerms: Set<string>;
  fieldTerms: Set<string>;
}

/**
 * Memoized by chunk object identity: IndexManager reuses unchanged chunk
 * objects across refreshes (same self-eviction contract as `tokenizeChunk`).
 * This is what keeps FILTERED queries cheap — a folder/project-scoped search
 * previously rebuilt every per-chunk tf map on every query (~160 ms p50 at
 * 19k chunks); only the subset-dependent df/avgdl pass remains per query.
 */
const chunkStatsCache = new WeakMap<IndexedChunk, ChunkStats>();

function chunkStatsFor(chunk: IndexedChunk): ChunkStats {
  const hit = chunkStatsCache.get(chunk);
  if (hit) return hit;
  const doc = tokenizeChunk(chunk); // memoized by chunk identity
  const tf = new Map<string, number>();
  for (const term of doc) tf.set(term, (tf.get(term) ?? 0) + 1);
  const stats: ChunkStats = {
    tf,
    docLength: doc.length,
    headingTerms: new Set(tokenize(chunk.heading)),
    fieldTerms: fieldTermsFor(chunk),
  };
  chunkStatsCache.set(chunk, stats);
  return stats;
}

function buildStats(chunks: IndexedChunk[]): CorpusStats {
  const tf: Map<string, number>[] = [];
  const headingTerms: Set<string>[] = [];
  const fieldTerms: Set<string>[] = [];
  const docLengths: number[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const chunk of chunks) {
    const cs = chunkStatsFor(chunk);
    tf.push(cs.tf);
    docLengths.push(cs.docLength);
    totalLen += cs.docLength;
    for (const term of cs.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    headingTerms.push(cs.headingTerms);
    fieldTerms.push(cs.fieldTerms);
  }
  return {
    chunks,
    tf,
    headingTerms,
    fieldTerms,
    docLengths,
    df,
    avgdl: totalLen / (chunks.length || 1),
    N: chunks.length,
  };
}

export class LexicalRetriever implements Retriever {
  readonly mode = "lexical";
  /** Memoized whole-corpus stats, keyed by the chunks array identity (which
   * IndexManager replaces on refresh), so repeated queries over an unchanged
   * vault reuse them instead of rebuilding tf/df from scratch each time. */
  private cached: CorpusStats | null = null;
  /** Stats for the LAST filtered subset. An agent session scoped to one
   * project repeats the same filter across queries; one entry captures that
   * pattern (ever-changing filters like sinceMtime simply miss). Keyed by
   * corpus identity + filter key; consumers score over `stats.chunks`, so
   * index alignment is by construction, not by re-filter determinism. */
  private filteredCached: { corpus: IndexedChunk[]; filterKey: string; stats: CorpusStats } | null = null;

  constructor(private readonly options: LexicalRetrieverOptions = {}) {}

  private statsFor(chunks: IndexedChunk[], filtered: IndexedChunk[], filterKey: string): CorpusStats {
    // Whole-vault search (the hot path): stats over `filtered` equal stats over
    // `chunks`, so memoize by identity. A filtered subset gets fresh stats so IDF
    // reflects exactly the searched set (unchanged from the per-query behavior).
    if (filtered !== chunks) {
      const hit = this.filteredCached;
      if (hit && hit.corpus === chunks && hit.filterKey === filterKey) return hit.stats;
      const stats = buildStats(filtered);
      this.filteredCached = { corpus: chunks, filterKey, stats };
      return stats;
    }
    if (!this.cached || this.cached.chunks !== chunks) this.cached = buildStats(chunks);
    return this.cached;
  }

  retrieve(query: RetrievalQuery, chunks: IndexedChunk[]): RetrievalResult[] {
    const queryTerms = tokenize(query.query);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const filtered = applyFilters(chunks, query.filters, this.options.projectRootResolver);
    if (queryTerms.length === 0 || filtered.length === 0) return [];

    const stats = this.statsFor(chunks, filtered, JSON.stringify(query.filters ?? {}));
    // Score over the array the stats were built from (a cached filtered subset
    // may be a PREVIOUS applyFilters result — equal contents, different array).
    const candidates = stats.chunks;
    const uniqueQueryTerms = Array.from(new Set(queryTerms));

    // IDF depends only on the term and the corpus — recomputing it per
    // (chunk, term) pair, plus allocating a matched-terms array per scoring
    // chunk, measurably dominated this loop (hoisting both cut lexical p50 by
    // ~24% at 19k chunks). matchedTerms is rebuilt for page survivors below.
    const idf = uniqueQueryTerms.map((term) => {
      const n = stats.df.get(term) ?? 0;
      return Math.log(1 + (stats.N - n + 0.5) / (n + 0.5));
    });

    const scored: Array<{ chunk: IndexedChunk; score: number; i: number }> = [];
    for (let i = 0; i < candidates.length; i++) {
      // A chunk whose body tokenizes to nothing can still deserve field credit
      // (e.g. a non-Latin body under an ASCII filename).
      if (stats.docLengths[i] === 0 && stats.fieldTerms[i].size === 0) continue;
      const tf = stats.tf[i];
      let score = 0;
      for (let t = 0; t < uniqueQueryTerms.length; t++) {
        const term = uniqueQueryTerms[t];
        const f = tf.get(term);
        if (!f) {
          if (stats.fieldTerms[i].has(term)) score += idf[t] * FIELD_MATCH_WEIGHT;
          continue;
        }
        const denom = f + K1 * (1 - B + (B * stats.docLengths[i]) / stats.avgdl);
        let termScore = (idf[t] * (f * (K1 + 1))) / denom;
        if (stats.headingTerms[i].has(term)) termScore *= HEADING_BOOST;
        score += termScore;
      }

      if (score > 0) scored.push({ chunk: candidates[i], score, i });
    }

    // Rank, diversify so a single long note can't flood the page, then build
    // snippets and matchedTerms only for the survivors — neither affects score
    // or ordering, so building them for every scoring chunk is wasted work.
    // The filter reproduces the old per-chunk accumulation exactly: same
    // uniqueQueryTerms order, same tf-membership test.
    scored.sort((a, b) => b.score - a.score);
    return diversifyByNote(scored, limit).map((s) => ({
      chunk: s.chunk,
      score: s.score,
      snippet: buildSnippet(s.chunk.text, uniqueQueryTerms),
      matchedTerms: uniqueQueryTerms.filter((t) => stats.tf[s.i].has(t) || stats.fieldTerms[s.i].has(t)),
    }));
  }
}

/** Convenience helper for callers that just want ranked results from an index. */
export function lexicalSearch(
  queryText: string,
  chunks: IndexedChunk[],
  opts: { limit?: number; filters?: RetrievalFilters; projectRootResolver?: (p: string) => string } = {},
): RetrievalResult[] {
  const retriever = new LexicalRetriever({ projectRootResolver: opts.projectRootResolver });
  return retriever.retrieve({ query: queryText, limit: opts.limit, filters: opts.filters }, chunks);
}
