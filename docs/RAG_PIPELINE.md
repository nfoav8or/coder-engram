# RAG pipeline

The retrieval pipeline is four stages: **scan → chunk → index → retrieve**. Everything runs locally with no API key. Lexical (BM25) retrieval is the offline default; embedding-based vector and hybrid retrieval are available once an embedding provider is configured.

## 1. Scan (`indexing/vault-scanner.ts`)

`VaultScanner.scan(config)` enumerates all Markdown files via the `VaultAdapter` and applies filters in order of cheapness:

1. **Included folders** — an allowlist. Empty means the whole vault. A note must be under one of these folders to survive.
2. **Excluded folders** — a denylist. Folder matching is segment-boundary aware, so `Archive` does not accidentally match `Archived Notes`.
3. **Excluded path patterns** — glob (`*` within a segment, `**` across slashes) or plain substring, matched case-insensitively against the full path. Intended for sensitive notes.
4. **Excluded tags** — requires reading the file and extracting metadata; a note carrying any excluded tag is dropped.

Steps 1–3 are path-only (no file read); step 4 reads and parses each surviving note. Read/parse failures on individual notes are logged and skipped, never fatal. The output is a list of `ScannedNote` records (`path`, `mtime`, `content`, `metadata`).

Metadata comes from `core/metadata-extractor.ts`, which parses (without a YAML dependency) frontmatter tags/aliases/title, inline `#tags`, wikilinks, and relative Markdown links, and records `bodyStartLine` so the chunker can skip frontmatter.

## 2. Chunk (`core/markdown-chunker.ts`)

`chunkMarkdown(content, options)` turns a note into retrieval-friendly chunks:

- **Heading sections.** ATX headings (`#`..`######`) delimit sections. Each section becomes a chunk carrying its heading text and a breadcrumb (`headingPath`) of ancestor headings, plus the 0-based inclusive line span it covers.
- **Code-fence aware.** Fenced blocks (` ``` ` / `~~~`) are opaque: a `#` inside a fence is not treated as a heading, so code is never split on a false heading.
- **Windowing long sections.** A section longer than `maxChars` (default **1200**) is split on paragraph (blank-line) boundaries into greedy windows, with **150** characters of overlap (`overlapChars`) carried between windows so context is not lost at boundaries.

Chunk options default to `{ maxChars: 1200, overlapChars: 150 }` and receive `bodyStartLine` from the note's metadata.

## 3. Index (`indexing/index-manager.ts`)

`IndexManager` maintains the local JSON index:

- **Records.** Each `IndexedChunk` carries `id` (`<notePath>::<ordinal>`), `notePath`, `heading`, `headingPath`, `text`, `startLine`/`endLine`, `tags`, `aliases`, `links`, and `mtime`.
- **Files.** `chunks.json` (the chunk records), `metadata.json` (`version`, `builtAt`, `noteCount`, `chunkCount`), and `embeddings.json` (an empty shell until an embedding provider is configured: `{ "model": null, "dim": 0, "vectors": {} }`, then populated with cached vectors).
- **Build.** `build(notes)` re-chunks every note and replaces the in-memory index.
- **Incremental refresh.** `refresh(notes)` compares by `mtime`: notes whose mtime is unchanged keep their existing chunks; new/modified notes are re-chunked; notes absent from the scan are dropped. Returns counts of `added` / `updated` / `removed` / `unchanged`.
- **Persist.** Writes each file through the adapter (atomic where the platform allows). The `embeddings.json` shell is only written if it does not already exist.
- **Load.** `load()` returns a persisted index, or `null` (triggering a rebuild) if it is missing, unparseable, or its `version` does not match `INDEX_VERSION`.

The engine loads a persisted index on layout-ready without blocking plugin load; **Reindex Vault** does a full rebuild; auto-index-on-change (off by default) does a debounced (~2.5s) incremental refresh.

## 4. Retrieve (`retrieval/`)

Retrieval is defined by the `Retriever` interface (`retrieval/retriever.ts`), so a vector retriever can replace or complement the lexical one without changing callers.

### BM25 lexical retrieval (`retrieval/lexical-retriever.ts`)

`LexicalRetriever` implements BM25 over the candidate chunks:

- **Filtering first** (`retrieval/ranking.ts` `applyFilters`). Structural filters run before scoring: `folder` (segment-boundary aware), `project` (mapped to its folder via the engine's `projectRootResolver`), `tag` (leading `#` normalized away), and `sinceMtime` (recency). BM25 IDF is then computed over the filtered set, so it reflects the corpus actually being searched.
- **Tokenization.** Lowercased, split on non-alphanumerics, dropping stopwords and 1-character tokens.
- **Scoring.** Standard BM25 with `k1 = 1.5`, `b = 0.75`. A chunk whose heading contains a query term gets a `1.15` heading boost on that term.
- **Results.** Each `RetrievalResult` carries the `chunk`, `score`, a `snippet` (a ~220-char window centered on the first match, via `buildSnippet`), and the `matchedTerms`. Results are sorted by score and truncated to the query limit (default `DEFAULT_LIMIT = 8`).

### Embedding abstraction

`embeddings/embedding-provider.ts` defines the `EmbeddingProvider` interface (`embed`, `isAvailable`, `dimensions`) and a `cosineSimilarity` helper. `embeddings/mock-embedding-provider.ts` is a deterministic, dependency-free hash-based provider (default 64 dims, L2-normalized) used for development and tests — it is **not** semantically meaningful.

The settings dropdown offers `none`, `mock`, `ollama`, and `openai-compatible` providers. The provider selection, together with the `retrievalMode` setting (`lexical`, `hybrid`, or `vector`; default `hybrid`), now drives which retriever runs: with a real provider configured, `VectorRetriever` (cosine) and `HybridRetriever` (RRF of lexical + vector) are used. When the provider is `none` or unavailable, retrieval degrades to `LexicalRetriever`, so it stays lexical and offline until a provider is configured.
