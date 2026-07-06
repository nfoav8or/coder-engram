/**
 * scale.bench — E1 production-scale benchmark for the retrieval pipeline.
 *
 * Drives the REAL pure core (VaultScanner -> IndexManager -> Lexical/Hybrid
 * retrievers) over a large synthetic in-memory vault and reports build time,
 * incremental-refresh time, index footprint, and per-query latency (p50/p95) for
 * lexical and hybrid modes. It exists to turn "unmeasured at scale" into numbers
 * and to catch catastrophic (e.g. O(n^2)) regressions on the hot query path.
 *
 * NOT part of `npm test` / CI (that suite must stay fast). Run on demand:
 *   npm run bench                 # default: 2000 notes, dim 384, 100 queries
 *   BENCH_NOTES=5000 npm run bench # push to production scale
 *
 * The embedding vectors are synthetic (deterministic pseudo-random) — they
 * measure the COMPUTE cost of vector/hybrid retrieval at scale, not retrieval
 * quality (quality is covered by the unit + e2e suites). The query-embedding
 * network round-trip is a provider concern and out of scope here.
 */

import { describe, it, expect } from "vitest";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { VaultScanner, ScanConfig } from "../src/indexing/vault-scanner";
import { IndexManager } from "../src/indexing/index-manager";
import { LexicalRetriever } from "../src/retrieval/lexical-retriever";
import { HybridRetriever } from "../src/retrieval/hybrid-retriever";

const NOTES = Number(process.env.BENCH_NOTES ?? 2000);
const DIM = Number(process.env.BENCH_DIM ?? 384);
const QUERIES = Number(process.env.BENCH_QUERIES ?? 100);

/** mulberry32 — small deterministic PRNG so corpora/vectors are reproducible. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string → 32-bit seed (for per-chunk deterministic vectors). */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// A small domain vocabulary so generated notes look like real memory notes and
// queries drawn from it actually match (exercising scoring + snippet + diversity).
const VOCAB = [
  "vault", "indexing", "retrieval", "embedding", "chunk", "markdown", "memory",
  "obsidian", "lexical", "vector", "hybrid", "cosine", "ranking", "snippet",
  "pipeline", "provider", "ollama", "openai", "server", "settings", "session",
  "project", "decision", "architecture", "security", "inbox", "pending", "token",
  "scanner", "metadata", "heading", "paragraph", "query", "score", "cache",
  "identity", "degrade", "localhost", "rebinding", "constant", "append", "review",
];

function words(rng: () => number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(VOCAB[Math.floor(rng() * VOCAB.length)]);
  return out.join(" ");
}

/** One synthetic note: a title + several headed sections, some long enough to
 * force the chunker to window (so notes produce multiple chunks per note — the
 * case per-note diversity and windowing actually care about at scale). */
function makeNote(i: number): string {
  const rng = makeRng(i * 2654435761);
  const lines: string[] = [`# Note ${i} — ${words(rng, 3)}`, ""];
  const sections = 3 + Math.floor(rng() * 4); // 3..6 sections
  for (let s = 0; s < sections; s++) {
    lines.push(`## ${words(rng, 2)}`, "");
    // ~1/3 of sections are long enough (> chunker maxChars 1200) to window.
    const paras = rng() < 0.34 ? 3 + Math.floor(rng() * 3) : 1;
    for (let p = 0; p < paras; p++) {
      const sentenceCount = 4 + Math.floor(rng() * 6);
      const sentences: string[] = [];
      for (let c = 0; c < sentenceCount; c++) {
        sentences.push(words(rng, 8 + Math.floor(rng() * 12)) + ".");
      }
      lines.push(sentences.join(" "), "");
    }
  }
  return lines.join("\n");
}

const SCAN_CONFIG: ScanConfig = {
  includedFolders: [],
  excludedFolders: [],
  excludedTags: [],
  excludedPathPatterns: [],
};

function timed<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const r = fn();
  return [r, performance.now() - t0];
}

async function timedAsync<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const r = await fn();
  return [r, performance.now() - t0];
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil(p * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

function measureQueries(run: (q: string) => void, queryTerms: string[]): {
  p50: number;
  p95: number;
  mean: number;
} {
  const samples: number[] = [];
  for (let i = 0; i < queryTerms.length; i++) {
    const [, ms] = timed(() => run(queryTerms[i]));
    samples.push(ms);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), mean };
}

/** Deterministic synthetic embedding for a chunk (measures compute, not quality). */
function fakeVector(seed: number): number[] {
  const rng = makeRng(seed);
  const v = new Array<number>(DIM);
  for (let d = 0; d < DIM; d++) v[d] = rng() * 2 - 1;
  return v;
}

describe(`scale benchmark (${NOTES} notes, dim ${DIM}, ${QUERIES} queries)`, () => {
  it(
    "builds, refreshes, and queries a production-scale vault within sane bounds",
    async () => {
      // --- generate corpus ---
      const [seed, genMs] = timed(() => {
        const files: Record<string, string> = {};
        for (let i = 0; i < NOTES; i++) files[`Notes/note-${i}.md`] = makeNote(i);
        return files;
      });
      const adapter = new InMemoryVaultAdapter("bench", seed);
      const scanner = new VaultScanner(adapter);
      const im = new IndexManager(adapter, {
        chunksFile: "Index/chunks.json",
        metadataFile: "Index/metadata.json",
        embeddingsFile: "Index/embeddings.json",
      });

      // --- scan + full build ---
      const [scanned, scanMs] = await timedAsync(() => scanner.scan(SCAN_CONFIG));
      const [index, buildMs] = timed(() => im.build(scanned));
      const chunkCount = index.chunks.length;

      // --- footprint (E2): deterministic on-disk / in-memory sizes ---
      const chunksBytes = JSON.stringify(index.chunks).length;
      const vectorsBytes = chunkCount * DIM * 8; // number[] of doubles, ~8B each

      // --- incremental refresh: touch a handful, re-scan, refresh ---
      const TOUCHED = Math.min(10, NOTES);
      for (let i = 0; i < TOUCHED; i++) {
        adapter.touch(`Notes/note-${i}.md`, makeNote(i) + `\n\n## extra\n\n${words(makeRng(i + 1), 20)}\n`);
      }
      // Pass the manager's known mtimes, as engine.refresh does in production:
      // unchanged notes are skipped without a read, so this measures the real
      // debounced-refresh path (O(changed) in file I/O), not a full re-read.
      const [rescanned, rescanMs] = await timedAsync(() => scanner.scan(SCAN_CONFIG, im.getNoteMtimes()));
      const [refreshResult, refreshMs] = timed(() => im.refresh(rescanned));

      // --- build query set drawn from the same vocab (so results are non-empty) ---
      const qrng = makeRng(1234);
      const queryTerms: string[] = [];
      for (let i = 0; i < QUERIES; i++) queryTerms.push(words(qrng, 2 + Math.floor(qrng() * 2)));

      const chunks = im.getChunks();

      // --- lexical query latency ---
      const lexical = new LexicalRetriever();
      const lexStats = measureQueries((q) => {
        lexical.retrieve({ query: q, limit: 8 }, chunks);
      }, queryTerms);

      // --- synthetic vectors + hybrid query latency ---
      const [vectors, vecBuildMs] = timed(() => {
        const m = new Map<string, number[]>();
        for (const c of chunks) m.set(c.id, fakeVector(hashSeed(c.id)));
        return m;
      });
      const hybrid = new HybridRetriever({ vectors });
      const queryVector = fakeVector(hashSeed("query"));
      const hybridStats = measureQueries((q) => {
        hybrid.retrieve({ query: q, limit: 8, queryVector }, chunks);
      }, queryTerms);

      const heap = process.memoryUsage().heapUsed;

      // --- report ---
      const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
      /* eslint-disable no-console */
      console.log(`\n===== Engram scale benchmark =====`);
      console.log(`corpus:          ${NOTES} notes -> ${chunkCount} chunks (${(chunkCount / NOTES).toFixed(1)} chunks/note)`);
      console.log(`generate:        ${genMs.toFixed(0)} ms`);
      console.log(`scan:            ${scanMs.toFixed(0)} ms`);
      console.log(`full build:      ${buildMs.toFixed(0)} ms`);
      console.log(`incremental:     scan ${rescanMs.toFixed(0)} ms + refresh ${refreshMs.toFixed(1)} ms (touched ${TOUCHED}, unchanged ${refreshResult.unchanged})`);
      console.log(`chunks.json:     ${mb(chunksBytes)} MB`);
      console.log(`vectors (dim ${DIM}): ~${mb(vectorsBytes)} MB (built in ${vecBuildMs.toFixed(0)} ms)`);
      console.log(`heapUsed:        ${mb(heap)} MB (approx, no forced gc)`);
      console.log(`lexical query:   p50 ${lexStats.p50.toFixed(2)} ms  p95 ${lexStats.p95.toFixed(2)} ms  mean ${lexStats.mean.toFixed(2)} ms`);
      console.log(`hybrid query:    p50 ${hybridStats.p50.toFixed(2)} ms  p95 ${hybridStats.p95.toFixed(2)} ms  mean ${hybridStats.mean.toFixed(2)} ms`);
      console.log(`==================================\n`);
      /* eslint-enable no-console */

      // --- sanity guards (loose; machine-independent, catch catastrophic regressions) ---
      // Windowing actually happened at scale.
      expect(chunkCount).toBeGreaterThan(NOTES);
      // Incremental refresh reused everything it should have (correctness at scale)...
      expect(refreshResult.unchanged).toBe(NOTES - TOUCHED);
      expect(refreshResult.updated).toBe(TOUCHED);
      // ...and is dramatically cheaper than a full rebuild (proves it's incremental).
      expect(refreshMs).toBeLessThan(buildMs);
      // Query latency stays interactive — these are generous ceilings for the
      // default 2000-note corpus; an O(n^2) regression blows well past them.
      expect(lexStats.p95).toBeLessThan(1000);
      expect(hybridStats.p95).toBeLessThan(2000);
    },
    120_000,
  );
});
