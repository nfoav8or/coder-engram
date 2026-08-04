# RAG pipeline

The retrieval pipeline is four stages: **scan → chunk → index → retrieve**. Everything runs locally with no API key. Lexical (BM25) retrieval is the offline default; embedding-based vector and hybrid retrieval are available once an embedding provider is configured.

## 1. Scan (`indexing/vault-scanner.ts`)

`VaultScanner.scan(config)` enumerates all Markdown files via the `VaultAdapter` and applies filters in order of cheapness:

1. **Included folders** — an allowlist. Empty means the whole vault. A note must be under one of these folders to survive.
2. **Excluded folders** — a denylist. Folder matching is segment-boundary aware, so `Archive` does not accidentally match `Archived Notes`.
3. **Excluded path patterns** — glob (`*` within a segment, `**` across slashes) or plain substring, matched case-insensitively against the full path. Intended for sensitive notes.
4. **Excluded tags** — requires reading the file and extracting metadata; a note carrying any excluded tag is dropped.

Steps 1–3 are path-only (no file read); step 4 reads and parses each surviving note. Read/parse failures on individual notes are logged and skipped, never fatal. The output is a list of `ScannedNote` records (`path`, `mtime`, `content`, `metadata`).

When **Index attachments** is enabled, a parallel pass (`engine.scanAttachments`) lists binary files by extension, runs them through the injected `TextExtractor`s (`extract/`: PDF via Obsidian's pdf.js, Office/OpenDocument via a dependency-free ZIP+XML reader, RTF, txt/csv, Canvas), and emits the extracted markdown as ordinary `ScannedNote`s — everything downstream (chunking, refresh, exclusions, retrieval, MCP tools) treats them identically to notes. Extraction runs once per (path, mtime) and is cached in `Index/extracted.json`, including negative results.

Metadata comes from `core/metadata-extractor.ts`, which parses (without a YAML dependency) frontmatter tags/aliases/title, inline `#tags`, wikilinks, and relative Markdown links, and records `bodyStartLine` so the chunker can skip frontmatter.

## 2. Chunk (`core/markdown-chunker.ts`)

`chunkMarkdown(content, options)` turns a note into retrieval-friendly chunks:

- **Heading sections.** ATX headings (`#`..`######`) delimit sections. Each section becomes a chunk carrying its heading text and a breadcrumb (`headingPath`) of ancestor headings, plus the 0-based inclusive line span it covers.
- **Code-fence aware.** Fenced blocks (` ``` ` / `~~~`) are opaque: a `#` inside a fence is not treated as a heading, so code is never split on a false heading.
- **Extracted text is capped at 1 MB per attachment** (`EXTRACTED_TEXT_MAX_CHARS`), clipped with a notice in the text. The 50 MB read cap bounds input, not output; this bounds what one file can contribute to the corpus. A no-text result stays no text rather than becoming a notice-only document.
- **All attachments together are capped at 32 MB of text per scan** (`ATTACHMENT_TEXT_BUDGET_CHARS`). The per-file ceiling bounds one document and says nothing about a thousand of them, while the extraction cache and the index are each a single JSON document — past ~512 MB `JSON.stringify` throws `RangeError: Invalid string length` and the whole refresh aborts. Attachments past the budget are skipped in scan order (stable across runs) and logged, and are pruned from the extraction cache, so the result is a bounded partial index rather than none at all.
- **Tags and links of an attachment are derived once, then cached with its text.** The attachment pass walks every attachment on every refresh (the markdown side is O(changed)), so re-deriving metadata for unchanged text dominated an incremental refresh. Measured two ways: **716 ms** over link-dense text at the 32 MB budget (worst case — a wikilink every few words), and **11.8 ms → 1.1 ms** on the `attachment refresh` benchmark's 300 attachments of ordinary prose (2.8 MB), which extrapolates to roughly 130 ms at the budget. `CacheEntry.metadata` is optional, so a cache file written before the field self-upgrades in place rather than forcing re-extraction; it is derived from the text, so `CACHE_VERSION` must be bumped when the metadata extractor's output changes, exactly as for an extractor fix. Tag *exclusion* is still evaluated at emit time, so a tag-config change re-applies without re-extraction.
- **Attachment reads are skipped when nothing needs the bytes.** An extractor may declare `needsBytes: false` (only the OCR adapter does — it passes the path to a companion plugin that owns its own cache). The scan then hands it an empty buffer instead of loading the file, so enabling image indexing does not read every picture in the vault into memory to discard it.
- **Windowing long sections.** A section longer than `maxChars` (default **2000**) is split on paragraph (blank-line) boundaries into greedy windows, with **150** characters of overlap (`overlapChars`) carried between windows so context is not lost at boundaries. A paragraph that contains no blank line — pasted JSON, base64, a wide table row, prose wrapped without blank lines — cannot be split by that rule, so it is broken at whitespace into pieces that fit the budget (a single token longer than the budget is hard-sliced). Each piece inherits its paragraph's line span, which is exact for the common single-line case.

Chunk options default to `{ maxChars: 2000, overlapChars: 150 }` and receive `bodyStartLine` from the note's metadata. The budget is set by **relevance**, not by the cost curve: at 2000 notes, 1200 → 2000 cuts the corpus 19,132 → 14,407 chunks (−25%), the index 18.0 → 16.1 MB, and lexical p50 15.8 → 10.9 ms (−31%). Cost keeps improving past that, but a fact buried in a long section holds MRR 1.00 up to 2200 and falls to 0.83 at 2400 (the `longnote` eval class) as larger chunks dilute BM25 term density — so 2000 sits a step below the boundary. Changing chunk boundaries requires bumping `INDEX_VERSION` so existing indexes rebuild instead of being scored against the old chunking.

## 3. Index (`indexing/index-manager.ts`)

`IndexManager` maintains the local JSON index:

- **Records.** Each `IndexedChunk` carries `id` (`<notePath>::<ordinal>`), `notePath`, `heading`, `headingPath`, `text`, `startLine`/`endLine`, `tags`, `aliases`, `links`, and `mtime`.
- **Files.** `chunks.json` (the chunk records), `metadata.json` (`version`, `builtAt`, `noteCount`, `chunkCount`), and `embeddings.json` (an empty shell until an embedding provider is configured: `{ "model": null, "dim": 0, "vectors": {} }`, then populated with cached vectors).
- **Build.** `build(notes)` re-chunks every note and replaces the in-memory index.
- **Incremental refresh.** `refresh(notes)` compares by `mtime` (a per-note mtime map, so even zero-chunk empty notes track correctly): notes whose mtime is unchanged keep their existing chunks; new/modified notes are re-chunked; notes absent from the scan are dropped. Returns counts of `added` / `updated` / `removed` / `unchanged`. The scan itself is incremental too: the engine passes the manager's known mtimes to `VaultScanner.scan`, which returns content-less stubs for unchanged notes **without reading them from disk** — so a debounced refresh is O(changed) in file I/O, not O(vault). The fast path is invalidated whenever the scan config changes (a new exclusion must re-check every note, not trust verdicts scanned under the old config). An all-unchanged refresh keeps the chunks-array identity (preserving the corpus-stats memo below) and skips the persist entirely.
- **Persist.** Writes each file through the adapter (atomic where the platform allows). The `embeddings.json` shell is only written if it does not already exist. A refresh that changed nothing does not persist — the index files live inside the vault, so writing them would re-fire the vault watcher and schedule the next refresh forever (the watcher additionally ignores the plugin's own `Index/`/`Config/` paths).
- **Load.** `load()` returns a persisted index, or `null` (triggering a rebuild) if it is missing, unparseable, or its `version` does not match `INDEX_VERSION`.

The engine loads a persisted index on layout-ready without blocking plugin load; **Reindex Vault** does a full rebuild; auto-index-on-change (off by default) does a debounced (~2.5s) incremental refresh.

## 4. Retrieve (`retrieval/`)

Retrieval is defined by the `Retriever` interface (`retrieval/retriever.ts`), so a vector retriever can replace or complement the lexical one without changing callers.

### BM25 lexical retrieval (`retrieval/lexical-retriever.ts`)

`LexicalRetriever` implements BM25 over the candidate chunks:

- **Filtering first** (`retrieval/ranking.ts` `applyFilters`). Structural filters run before scoring: `folder` (segment-boundary aware), `project` (mapped to its folder via the engine's `projectRootResolver`), `tag` (leading `#` normalized away), and `sinceMtime` (recency). BM25 IDF is computed over the searched set: for a whole-vault query the corpus statistics are memoized (see below); a filtered subset gets fresh statistics so IDF reflects exactly that subset.
- **Tokenization.** Lowercased, split on non-alphanumerics, dropping stopwords and 1-character tokens.
- **Corpus statistics, computed once.** Per-chunk term frequencies, document lengths, per-chunk heading terms, and the global document-frequency map + average doc length depend only on the chunks, not the query. They are built once and **memoized by the chunks-array identity** (which `IndexManager` replaces on refresh), so repeated queries over an unchanged vault reuse them instead of re-tokenizing and re-counting the whole corpus per query. Chunk tokenization itself is separately memoized by chunk identity (`tokenizeChunk`, a `WeakMap`).
- **Scoring.** Standard BM25 with `k1 = 1.5`, `b = 0.75`. A chunk whose heading contains a query term gets a `1.15` heading boost on that term. **Field matching:** a query term absent from the chunk body but present in the note's **filename**, **frontmatter aliases**, or an **ancestor heading** is credited `idf × 1.0` — the BM25 score of one occurrence in an average-length body, so a field-only match can outrank a single mention buried in a long chunk (a note named for the query is at least that relevant) but loses to any stronger body match. Before this, a query matching only a note's name scored exactly 0 for that note.
- **Relevance eval.** `npm run eval` (`tests/relevance.bench.ts`, local-only like the scale bench) plants invented-term needle notes and reports recall@8 + MRR per query class (body / filename / heading / alias / plural / phrase). Ranking changes must move these numbers, not vibes. Current: all classes at 1.00 recall@8 (plural MRR 0.92); filename and alias were 0.00 before field matching.
- **Results.** Each `RetrievalResult` carries the `chunk`, `score`, a `snippet` (the densest-match window via `buildSnippet` — the window covering the most matches, not merely the first), and the `matchedTerms` (whole-token matches). Results are sorted by score, then **diversified so a single long note cannot flood the page** (`diversifyByNote`: at most `ceil(limit/3)`, floor 2, chunks per note, with rank-order backfill so the page is never shorter than a plain top-`limit`), and snippets are built only for the survivors. This retriever-level diversity is always on — it shapes the desktop search results too. The MCP search tool re-applies the same cap at page size after its deeper fetch, and *that* pass is what the **Cap one note's share of a page** setting governs; with it off, the tool takes the ranked pool as it comes. Default limit `DEFAULT_LIMIT = 8`.

### Performance at scale

Retrieval is measured by an on-demand benchmark (`npm run bench`, `tests/scale.bench.ts`; excluded from `npm test`/CI, like the e2e harness) that drives the real scanner → index → retriever path over a large synthetic in-memory vault. Representative numbers on a dev laptop (dense synthetic notes, ~9.5 chunks/note, 100 queries, embedding dim 384):

| corpus | chunks | full build | incremental refresh | lexical query p50/p95 | hybrid query p50/p95 |
| --- | --- | --- | --- | --- | --- |
| 2,000 notes | ~19k | ~55 ms | scan ~2 ms + refresh ~8 ms (10 changed) | 15 / 19 ms | 31 / 34 ms |
| 5,000 notes | ~48k | ~120 ms | scan ~4 ms + refresh ~19 ms (10 changed) | 55 / 63 ms | 102 / 114 ms |

Notes: incremental refresh reuses unchanged chunk objects and skips reading unchanged files entirely (the skip-unchanged scan cut the re-scan from ~60 ms to ~2 ms at 2k notes even on the in-memory adapter; on a real vault the saving is disk I/O, which is the part that matters). Lexical scoring iterates the whole candidate set per query (O(corpus)); the memoization above removes the per-query re-tokenization cost but not that linear scan, and the hybrid vector stage is O(chunks × dim) per query. Both stay interactive to tens of thousands of chunks; beyond that the levers are an inverted index (lexical) and approximate-nearest-neighbour search (vector) — deliberately not built yet, since real vaults sit well inside the measured range. Run `BENCH_NOTES=5000 npm run bench` to reproduce.

### Embedding abstraction

`embeddings/embedding-provider.ts` defines the `EmbeddingProvider` interface (`embed`, `isAvailable`, `dimensions`) and a `cosineSimilarity` helper. `embeddings/mock-embedding-provider.ts` is a deterministic, dependency-free hash-based provider (default 64 dims, L2-normalized) used for development and tests — it is **not** semantically meaningful.

The settings dropdown offers `none`, `mock`, `ollama`, and `openai-compatible` providers. The provider selection, together with the `retrievalMode` setting (`lexical`, `hybrid`, or `vector`; default `hybrid`), now drives which retriever runs: with a real provider configured, `VectorRetriever` (cosine) and `HybridRetriever` (RRF of lexical + vector) are used. When the provider is `none` or unavailable, retrieval degrades to `LexicalRetriever`, so it stays lexical and offline until a provider is configured.
