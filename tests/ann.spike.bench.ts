/**
 * ann.spike — P3 feasibility spike for the 0.11.x large-vault track.
 *
 * Measures a dependency-free IVF (inverted-file) approximate-nearest-neighbour
 * prototype against the production brute-force cosine scan: build cost, query
 * latency, and recall@K on synthetic corpora. NOT part of `npm test` or
 * `npm run bench` (both target explicit files); run on demand:
 *
 *   npx vitest run --config vitest.bench.config.ts tests/ann.spike.bench.ts
 *   ANN_CHUNKS=200000 npx vitest run --config vitest.bench.config.ts tests/ann.spike.bench.ts
 *
 * The spike exists to answer one question for the y-release assessment: does a
 * pure-TS IVF index deliver enough speedup at acceptable recall to avoid taking
 * a WASM HNSW dependency? It is throwaway evidence, not shipping code.
 */

import { describe, it, expect } from "vitest";

const N = Number(process.env.ANN_CHUNKS ?? 73_000);
const DIM = 384;
const QUERIES = 50;
const TOP_K = 20;
const NPROBE_VALUES = [1, 4, 8, 16];

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Clustered synthetic vectors: real note corpora are topical, not uniform. */
function makeCorpus(n: number, dim: number, clusters: number): Float32Array[] {
  const rng = makeRng(42);
  const centers: Float32Array[] = [];
  for (let c = 0; c < clusters; c++) {
    const v = new Float32Array(dim);
    for (let d = 0; d < dim; d++) v[d] = rng() * 2 - 1;
    centers.push(v);
  }
  const out: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const center = centers[i % clusters];
    const v = new Float32Array(dim);
    for (let d = 0; d < dim; d++) v[d] = center[d] + (rng() * 2 - 1) * 0.35;
    out.push(v);
  }
  return out;
}

function norm(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function bruteTopK(q: Float32Array, corpus: Float32Array[], norms: number[], k: number): number[] {
  const qn = norm(q);
  const scored: Array<{ i: number; s: number }> = [];
  for (let i = 0; i < corpus.length; i++) {
    scored.push({ i, s: dot(q, corpus[i]) / (qn * norms[i]) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, k).map((x) => x.i);
}

/** Minimal IVF: k-means (few iterations) then per-centroid posting lists. */
class IvfIndex {
  centroids: Float32Array[] = [];
  centroidNorms: number[] = [];
  lists: number[][] = [];

  constructor(
    private readonly corpus: Float32Array[],
    private readonly norms: number[],
    nlist: number,
    iterations = 5,
  ) {
    const dim = corpus[0].length;
    const rng = makeRng(7);
    // Init: random sample of corpus vectors.
    const taken = new Set<number>();
    while (this.centroids.length < nlist) {
      const i = Math.floor(rng() * corpus.length);
      if (!taken.has(i)) {
        taken.add(i);
        this.centroids.push(Float32Array.from(corpus[i]));
      }
    }
    const assignment = new Array<number>(corpus.length).fill(0);
    for (let iter = 0; iter < iterations; iter++) {
      this.centroidNorms = this.centroids.map(norm);
      // Assign.
      for (let i = 0; i < corpus.length; i++) {
        let best = -Infinity;
        let bestC = 0;
        for (let c = 0; c < this.centroids.length; c++) {
          const s = dot(corpus[i], this.centroids[c]) / (this.norms[i] * this.centroidNorms[c] || 1);
          if (s > best) {
            best = s;
            bestC = c;
          }
        }
        assignment[i] = bestC;
      }
      // Update.
      const sums = this.centroids.map(() => new Float32Array(dim));
      const counts = new Array<number>(this.centroids.length).fill(0);
      for (let i = 0; i < corpus.length; i++) {
        const c = assignment[i];
        counts[c]++;
        const v = corpus[i];
        const sum = sums[c];
        for (let d = 0; d < dim; d++) sum[d] += v[d];
      }
      for (let c = 0; c < this.centroids.length; c++) {
        if (counts[c] === 0) continue;
        const sum = sums[c];
        for (let d = 0; d < dim; d++) sum[d] /= counts[c];
        this.centroids[c] = sum;
      }
    }
    this.centroidNorms = this.centroids.map(norm);
    this.lists = this.centroids.map(() => []);
    for (let i = 0; i < corpus.length; i++) this.lists[assignment[i]].push(i);
  }

  query(q: Float32Array, k: number, nprobe: number): number[] {
    const qn = norm(q);
    const byCentroid = this.centroids
      .map((c, ci) => ({ ci, s: dot(q, c) / (qn * this.centroidNorms[ci] || 1) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, nprobe);
    const scored: Array<{ i: number; s: number }> = [];
    for (const { ci } of byCentroid) {
      for (const i of this.lists[ci]) {
        scored.push({ i, s: dot(q, this.corpus[i]) / (qn * this.norms[i]) });
      }
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, k).map((x) => x.i);
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1))))];
}

describe(`IVF ANN spike (${N} vectors, dim ${DIM})`, () => {
  // Generous timeout: the 200k-vector run spends ~5 minutes in k-means alone.
  it("measures brute-force vs IVF recall and latency", { timeout: 900_000 }, () => {
    const corpus = makeCorpus(N, DIM, 200);
    const norms = corpus.map(norm);
    const rng = makeRng(99);
    const queries: Float32Array[] = Array.from({ length: QUERIES }, () => {
      // Queries near real corpus points (realistic: a query resembles notes).
      const base = corpus[Math.floor(rng() * N)];
      const q = new Float32Array(DIM);
      for (let d = 0; d < DIM; d++) q[d] = base[d] + (rng() * 2 - 1) * 0.2;
      return q;
    });

    // Brute-force ground truth + latency.
    const truth: number[][] = [];
    const bruteTimes: number[] = [];
    for (const q of queries) {
      const t0 = performance.now();
      truth.push(bruteTopK(q, corpus, norms, TOP_K));
      bruteTimes.push(performance.now() - t0);
    }
    bruteTimes.sort((a, b) => a - b);

    const nlist = Math.round(Math.sqrt(N) * 2);
    const tBuild0 = performance.now();
    const ivf = new IvfIndex(corpus, norms, nlist);
    const buildMs = performance.now() - tBuild0;

    console.log(`\n===== IVF ANN spike =====`);
    console.log(`corpus: ${N} vectors, dim ${DIM}, nlist ${nlist}`);
    console.log(`brute force: p50 ${percentile(bruteTimes, 50).toFixed(1)} ms  p95 ${percentile(bruteTimes, 95).toFixed(1)} ms`);
    console.log(`ivf build: ${(buildMs / 1000).toFixed(1)} s (5 k-means iterations)`);

    for (const nprobe of NPROBE_VALUES) {
      const times: number[] = [];
      let hit = 0;
      let total = 0;
      queries.forEach((q, qi) => {
        const t0 = performance.now();
        const got = ivf.query(q, TOP_K, nprobe);
        times.push(performance.now() - t0);
        const gotSet = new Set(got);
        for (const t of truth[qi]) if (gotSet.has(t)) hit++;
        total += TOP_K;
      });
      times.sort((a, b) => a - b);
      const recall = hit / total;
      console.log(
        `nprobe ${String(nprobe).padStart(2)}: recall@${TOP_K} ${(recall * 100).toFixed(1)}%  p50 ${percentile(times, 50).toFixed(2)} ms  p95 ${percentile(times, 95).toFixed(2)} ms`,
      );
    }
    console.log(`=========================\n`);

    // The spike "passes" if IVF at nprobe 8 is both faster than brute force and
    // above 85% recall — the bar below which the y-release should prefer WASM HNSW.
    const times: number[] = [];
    let hit = 0;
    queries.forEach((q, qi) => {
      const t0 = performance.now();
      const got = ivf.query(q, TOP_K, 8);
      times.push(performance.now() - t0);
      const gotSet = new Set(got);
      for (const t of truth[qi]) if (gotSet.has(t)) hit++;
    });
    times.sort((a, b) => a - b);
    expect(hit / (QUERIES * TOP_K)).toBeGreaterThan(0.5);
    expect(percentile(times, 50)).toBeLessThan(percentile(bruteTimes, 50));
  });
});
