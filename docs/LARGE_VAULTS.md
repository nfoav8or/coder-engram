# Large vaults — the 0.11.x assessment (P2 + P3)

Status: assessment written after 0.10.7; **P2.1 (sharded persistence) and the yielding half of P2.3 shipped in 0.11.0** — see the notes in each section. Remaining items stand as assessed.
Nothing in this document is implemented yet unless it says so. Numbers marked *measured*
come from the benches in `tests/scale.bench.ts` and `tests/ann.spike.bench.ts` on the
development machine; treat them as one-machine evidence, not guarantees.

## Where the envelope stands after P1 (0.10.7)

The binding constraint is **heap** (~2.5 GB at 20k notes with dim-384 vectors), then the
**main-thread cost** of parsing/serializing single-file caches, then **first-pass
embedding time** (checkpointed and resumable since 0.10.7, but still linear in corpus
size). A 5 GB vault is roughly 2–5M chunks — 15–30× past the tested envelope — so P2/P3
are structural, not tuning.

Re-measured on the 0.11.1 code (`npm run bench` plus targeted probes), superseding the
first-pass figures taken before the inverted postings index and the binary vector format
landed:

| | 73k chunks (10k notes) | 145k chunks (20k notes) |
| --- | --- | --- |
| Full build | 685 ms | 624 ms |
| Hybrid query p50 | 143 ms | 360 ms (p95 688 ms) |
| Lexical query p50 | 106 ms (filtered) | 195 ms (p95 451 ms) |
| Incremental refresh (10 notes touched) | — | 30 ms |

**Read the lexical numbers with the benchmark's vocabulary in mind.** `scale.bench.ts`
draws from a 40-word vocabulary, so nearly every query term appears in nearly every
chunk — the exact worst case for an inverted index, whose entire purpose is to bound the
candidate set to actual matches. Re-measured at the same 145k-chunk scale against a
realistic Zipfian ~3000-word vocabulary, a query with genuinely selective terms
(document frequency ~1%) runs at **p50 10.3 ms**, ~22× faster than the 229 ms the
synthetic corpus produces, and hybrid becomes purely vector-bound (~121 ms). The bench
numbers above are therefore a pessimistic bound rather than a prediction for a real
vault, and most of the apparent regression against the older ~120 ms hybrid figure is
this artifact rather than the 0.11.x retrieval changes. That was not separated by an
A/B against a pre-0.11.x build, so it is the likely explanation, not a proven one.

**Evidence for P3.1's sizing:** decomposing a vector query at 145k chunks gives dot
products 39.8 ms, per-candidate object allocation +4 ms, and the final full
`Array.prototype.sort` of ~73k scored candidates **+22 ms — about a third of the
65.7 ms total** — all to then keep the top 8 (or the top 32 deep candidates hybrid asks
for). A bounded top-K selection would reclaim an estimated 15–18 ms per query on its
own. It is deliberately *not* being done as a patch-release change: it reorders results
whenever scores tie, and P3.1 replaces this scan wholesale. The measurement is recorded
here so that work starts with a number rather than an intuition.

## P2 — unlocks ~500k chunks

### P2.1 Sharded index persistence — SHIPPED (0.11.0)

> Shipped as designed with one refinement: the layout is **size-adaptive** with hysteresis (shard above 20k chunks/vectors, return to single-file below 80% of that), so small vaults keep byte-identical single-file behavior and never pay shard overhead. Both caches (chunks + embeddings) shard; embedding checkpoints now rewrite only dirty shards. A corrupt embedding shard drops only its own vectors. Hardened in the follow-up review pass: a missing chunk shard is damage (rebuild), never "no notes here"; a layout switch writes data, then metadata, then blanks the obsolete file, so a crash in the window cannot yield a valid empty index; the engine serializes `reindex`/`refresh` now that a pass yields mid-flight; the layout rules live once in `utils/sharding.ts`.

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

### P2.3 Worker-offloaded parse and chunking — PARTIAL (0.11.0 shipped the yielding fallback)

> The cooperative-yielding path (yield to the event loop every 500 re-chunked notes in `build`/`refresh`) is implemented — it removes the renderer-freeze failure mode everywhere, including hosts without workers, at sub-second total overhead even at 100k notes. The actual Worker (esbuild second entry point, message protocol, ArrayBuffer transfer) is deferred to the next 0.11.x step: it needs manual in-Obsidian verification that this development loop cannot provide, and the yielding path already caps the user-visible harm.

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

1. **0.11.0 (shipped)**: P2.1 shards + the yielding half of P2.3. The Worker itself
   slipped: it needs in-Obsidian verification, and yielding already caps the harm. It
   lands in whichever 0.11.x step first has that verification.
2. **0.11.1 and 0.11.2 (shipped)**: no large-vault work — hardening passes over the
   subsystems P2.1 had not touched, which turned up several fail-open bugs in tag
   extraction plus the re-embed-on-upgrade cost. Listed here only so the numbering
   below is not read as slipped scope.
3. **0.11.2**: P2.2 lazy text behind the chunk-handle accessor (the API-breaking one —
   isolated on purpose).
4. **0.11.3**: P3.1 IVF behind the existing `Retriever` interface + P3.2 mode switch,
   gated on a real-vault recall eval added to `npm run eval`.

Each step keeps every documented security invariant: all I/O through the adapter and
`resolveInVault`, caches rebuildable, exclusions applied before anything is read,
embeddings opt-in.

## Open questions for the maintainer

- ~~Shard count: fixed 256, or scaled by vault size?~~ **Settled in 0.11.0: fixed 256**
  (`SHARD_COUNT` in `src/utils/sharding.ts`). Fixed is simpler, and 256 shards of a 5 GB
  vault land around 20 MB each. A file claiming any other shard count is treated as
  corrupt and rebuilt rather than guessed at.
- Is IndexedDB categorically off the table, or acceptable as an optional cache location
  for users whose sync clients choke on `Index/`? (This doc assumes off the table.)
- Real-vault recall eval corpus: which vault/queries should gate the IVF ship decision?
