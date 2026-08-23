# Large vaults — the 0.11.x assessment (P2 + P3)

Status: **assessment for the next y-release**, written after the 0.10.7 P1 set shipped.
Nothing in this document is implemented yet unless it says so. Numbers marked *measured*
come from the benches in `tests/scale.bench.ts` and `tests/ann.spike.bench.ts` on the
development machine; treat them as one-machine evidence, not guarantees.

## Where the envelope stands after P1 (0.10.7)

Measured at 10k synthetic notes (~73k chunks): full build ~230 ms, hybrid query p50
~120 ms, filtered lexical p50 ~80 ms. Scaling is linear through 20k notes / 145k chunks;
the binding constraint is **heap** (~2.5 GB at 20k notes with dim-384 vectors), then the
**main-thread cost** of parsing/serializing single-file caches, then **first-pass
embedding time** (checkpointed and resumable since 0.10.7, but still linear in corpus
size). A 5 GB vault is roughly 2–5M chunks — 15–30× past the tested envelope — so P2/P3
are structural, not tuning.

## P2 — unlocks ~500k chunks

### P2.1 Sharded index persistence

`chunks.json` is one document, re-serialized whole on any change (165 MB at 20k notes).
Proposal: shard by hash of `notePath` into a fixed 256 buckets
(`Index/chunks/00.json` … `ff.json`), each with the current per-file shape. Refresh
marks shards dirty per changed note and rewrites only those. Same for
`embeddings.json` (the v2 binary format shards unchanged).

- Write amplification becomes O(changed notes), not O(vault); a one-note edit rewrites
  ~1/256 of the corpus.
- Sync clients stop re-uploading a 100+ MB file per edit — a real, user-visible cost of
  vault-resident caches today.
- The rebuildable-cache contract, `resolveInVault` choke-point, and "everything in the
  vault" doctrine are untouched — shards live under the same `Index/` root.
- Migration: on load, a legacy single-file cache is read once and rewritten as shards;
  version field in a small `Index/manifest.json` (name TBD — must not collide with the
  plugin's own `manifest.json`) records the layout.
- Rejected alternative: IndexedDB. It would cut sync traffic to zero and parse cost to
  near zero, but it is the one option that moves plugin-managed data outside the vault,
  is per-device (every machine re-embeds), and complicates the documented security
  story. Revisit only if sharding proves insufficient.

### P2.2 Lazy chunk text

Heap is dominated by chunk body strings. Retrieval already defers snippet building to
the ~dozen page survivors, and BM25 scoring needs term statistics, not text. Proposal:

- `IndexedChunk` keeps metadata (path, heading, line span, tags, links) plus the derived
  stats the retrievers need; `text` becomes lazily loaded via a per-shard text file, read
  on demand for snippet building, `get_note_context`, and `summarize_note`.
- The tokenize/stats caches (`tokenizeChunk`, `chunkStatsCache`) must be built at index
  time and PERSISTED per shard (they are currently derived from text on first query —
  with lazy text that would force a full text load, defeating the point). This folds
  naturally into P2.1's shard format: postings and stats become part of the shard.
- Estimated effect: resident heap per chunk drops from ~2 KB (text) to ~200 B
  (metadata + stats), putting 1M chunks near ~1 GB total with vectors — inside Electron
  headroom.
- Risk: this is the deepest cut of the set. `IndexedChunk.text` is read across the
  codebase (chunker, retrievers, summarizer, MCP tools, memory search). The type change
  should land behind an accessor (`getText(): Promise<string>` on a chunk handle) in its
  own release, with the architecture test extended to keep `Index/` reads inside the
  adapter.

### P2.3 Worker-offloaded parse and chunking

Initial chunking of a 5 GB vault on the renderer thread freezes Obsidian for minutes.
The pure core never imports `obsidian` or `node:*` as values — exactly the property that
lets scanning/chunking/stats-building run in a Web Worker verbatim (the pattern
community plugins like Omnisearch already use; Obsidian permits
`new Worker(URL.createObjectURL(...))` with a bundled worker script — esbuild gains a
second entry point).

- The worker owns: markdown chunking, content hashing, stats/postings building, shard
  serialization. The main thread owns: vault I/O (adapter), UI, the MCP server.
- Transferables: chunk text goes to the worker as strings; vectors come back as
  `ArrayBuffer` (zero-copy transfer — another payoff of the 0.10.7 binary format).
- Fallback: when workers are unavailable (tests, exotic hosts), run inline with
  cooperative yielding (`await new Promise(r => setTimeout(r))` every N notes) so the
  progress UI stays live. The Node test environment uses the inline path, keeping the
  suite deterministic.

## P3 — 1M+ chunks

### P3.1 Approximate-nearest-neighbour vector search

Spike result (`tests/ann.spike.bench.ts`, pure-TS IVF: k-means centroids + per-centroid
posting lists, probe the top `nprobe` clusters, exact cosine inside):

| Corpus | Brute p50 | IVF build | nprobe | Recall@20 | IVF p50 |
| --- | --- | --- | --- | --- | --- |
| 73k × 384d | 44.9 ms | 62.6 s | 1 | 74.9% | 0.47 ms |
| 73k × 384d | | | 4 | 100.0% | 0.78 ms |
| 73k × 384d | | | 8 | 100.0% | 1.53 ms |
| 200k × 384d | 140.0 ms | 292.7 s | 4 | 93.6% | 2.04 ms |
| 200k × 384d | | | 8 | 99.7% | 3.29 ms |
| 200k × 384d | | | 16 | 100.0% | 5.43 ms |

Read with care: the synthetic corpus is deliberately clustered (topical, like real
notes), which flatters recall — real embedding distributions are less separable, and
the recall bar must be re-validated against a real vault's vectors before shipping.
Even so, the shape of the result is decisive: **~57× query speedup at full recall@20
with nprobe 4 at 73k vectors, and ~43× at 99.7% recall (nprobe 8) at 200k**, in ~150
lines of dependency-free TypeScript. Note the scaling of the knob: recall at a fixed
nprobe degrades as the corpus grows (nprobe 4 fell from 100% to 93.6% between 73k and
200k), so nprobe must scale with nlist — probing a fixed FRACTION of clusters (~1–2%)
rather than a fixed count is the likely shipping rule. The 292.7 s build at 200k is the
strongest argument for pairing IVF with the P2.3 worker.

Recommendation: **pure-TS IVF, not WASM HNSW.**

- No new dependency (HNSW would mean auditing and bundling a WASM artifact — real
  supply-chain and review-weight cost for an Obsidian community plugin).
- IVF's structures are trivially persistable into the P2.1 shard format (centroids +
  assignments), and incrementally maintainable: an edited chunk re-embeds and is
  assigned to its nearest existing centroid (O(nlist·dim)); full k-means re-runs only
  when the corpus grows past a drift threshold (e.g. 30% new since last build).
- The 62.6 s build at 73k is k-means cost, one-time and worker-offloadable (P2.3); it
  amortizes exactly like the embedding pass itself and is two orders of magnitude
  cheaper than embedding the same corpus.
- Brute force stays as the fallback and the correctness oracle (same graceful-degrade
  shape as everything else in retrieval): corpora under ~50k chunks never build an IVF
  index at all, since brute force is already interactive there.

### P3.2 "Large vault mode"

One auto-detected switch (chunk count threshold, overridable in settings) that enables
the set coherently instead of exposing nine knobs: lazy text + IVF + (optionally)
int8-quantized vectors. Quantization is the one P3 lever deliberately deferred until a
real-vault recall eval exists: it cuts vector heap another 4× but is the only change
here that alters scores.

## Sequencing recommendation for 0.11.x

1. **0.11.0**: P2.1 shards + P2.3 worker (both are invisible to behavior; big, safe
   wins; shared shard format lands once). Migration: read legacy single files, write
   shards, done.
2. **0.11.1**: P2.2 lazy text behind the chunk-handle accessor (the API-breaking one —
   isolated on purpose).
3. **0.11.2**: P3.1 IVF behind the existing `Retriever` interface + P3.2 mode switch,
   gated on a real-vault recall eval added to `npm run eval`.

Each step keeps every documented security invariant: all I/O through the adapter and
`resolveInVault`, caches rebuildable, exclusions applied before anything is read,
embeddings opt-in.

## Open questions for the maintainer

- Shard count: fixed 256, or scaled by vault size? (Fixed is simpler; 256 shards of a
  5 GB vault ≈ 20 MB each, acceptable.)
- Is IndexedDB categorically off the table, or acceptable as an optional cache location
  for users whose sync clients choke on `Index/`? (This doc assumes off the table.)
- Real-vault recall eval corpus: which vault/queries should gate the IVF ship decision?
