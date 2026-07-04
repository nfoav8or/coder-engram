# Changelog

All notable changes to Claude Code Engram are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- New MCP tool **`get_note_context`**: returns the full **indexed** text of a single note, passage by passage, each labelled with its heading and line range — the natural follow-up to a `search_vault_memory` hit, which only returns a short snippet. Inputs: `path` (required) and `maxChars` (optional, default 12000, max 50000; the note is truncated past this). Rate-limited (60/min).

### Security

- `get_note_context` reuses the same **in-scope-only** gate as `summarize_note`: it reads only notes that are in the index, so an excluded or unindexed note has no chunks and is refused. It exposes no data that `search_vault_memory` did not already surface from the same indexed corpus, adds no generic file-read or full-vault dump, and remains behind the server's existing localhost + token + DNS-rebinding gating.

## [0.2.0] — 2026-07-04

Milestone 6 — retrieval quality. A focused round of relevance, navigation, and performance improvements on top of the 0.1.0 RAG core. No settings or schema changes, no new network egress, and no breaking changes: an in-place upgrade. See [docs/RAG_PIPELINE.md](docs/RAG_PIPELINE.md).

### Added

- **Precise per-chunk line spans.** The chunker now records the exact original-line span each window covers (rather than every window sharing its section's span). Search results display the line range (e.g. "Lines 5–8"), and clicking a result opens the note with the cursor on the chunk's start line instead of the file top.
- **Per-note result diversity.** A single long note can no longer flood the result page: at most `ceil(limit/3)` (floor 2) chunks per note are shown, with rank-order backfill so the page is never shorter than a plain top-`limit` and a query matching only one note still fills from it.
- **Developer test harnesses (not shipped in the plugin):** a Playwright end-to-end UI smoke test that drives the real plugin inside real Obsidian (`npm run test:e2e`), and an on-demand retrieval scale benchmark over a large synthetic vault (`npm run bench`). Both are local-only and excluded from `npm test`/CI.

### Changed

- **Snippets and highlighting.** Snippets now select the window covering the *most* query-term matches (densest context) rather than centering on the first match, and both snippets and UI `<mark>` highlighting use whole-token matching so a query term like `art` matches the word but not the `art` inside `restart`.

### Performance

- **BM25 corpus statistics are memoized.** Per-chunk term frequencies, document frequencies, average document length, and per-chunk heading tokens were previously recomputed from scratch on every query. They are now computed once and cached by the chunk-set identity (invalidated on reindex), cutting lexical query latency ~7× and hybrid ~5× on a large vault (≈157 ms → 21 ms lexical, ≈174 ms → 37 ms hybrid at ~19k chunks). Behavior is unchanged.
- Snippet building is deferred until after the result limit is applied, and chunk tokenization is memoized by chunk identity, so broad queries no longer build snippets or re-tokenize for chunks that get discarded.

### Removed

- Dead code: `parentPath`, `ProjectMemory.projectExists`, `Debounced.flush`, and the unused `RetrievalError` / `AuthError` classes. Also fixed a stray NUL byte in `engine.ts` that made the file read as binary to text tools.

### Security

- The retrieval changes are pure in-memory result-shaping over already-filtered, already-scored chunks — no path, write, network, or authentication surface is touched, so all six security invariants (in-vault writes only, inbox-first, localhost/token/DNS-rebinding server gating, UI-only promotion, opt-in embeddings, safe settings migration) are unchanged. Excluded/sensitive notes remain unindexed and therefore never scored, snippeted, or embedded.

## [0.1.0] — 2026-07-03

First tagged release of Claude Code Engram — a local-first memory + RAG layer for Claude Code, storing memory as Markdown inside your Obsidian vault. It comprises Milestones 1–5, detailed below: the memory + lexical RAG core (M1), the local MCP/HTTP server (M2), embedding providers with vector + hybrid retrieval (M3), the pending-memory review UI plus extractive `summarize_note` (M4), and CI + release packaging (M5). See [docs/ROADMAP.md](docs/ROADMAP.md).

## Milestone 5 — CI + release/packaging

### Added

- GitHub Actions **CI** (`.github/workflows/ci.yml`): typecheck, lint, test, and build on every push to `main`/`develop` and every pull request, with a read-only token.
- GitHub Actions **Release** (`.github/workflows/release.yml`): on a version-tag push it gates on a green typecheck/lint/test/build, verifies the tag matches `manifest.json` (a leading `v` is tolerated), and publishes `main.js`, `manifest.json`, and `styles.css` to a GitHub Release via the runner's `gh` CLI.
- Version tooling (`version-bump.mjs` plus an `npm version` script) that keeps `manifest.json` and `versions.json` in sync with `package.json`.

### Security

- The release workflow is least-privilege (`contents: write` only), uses the built-in `GITHUB_TOKEN` and the runner's `gh` CLI with no third-party publish actions, has no `pull_request_target`, and grants fork pull requests only a read-only token. No secrets are written into build artifacts.

## Milestone 4 — Review UI + extractive summarize_note

A richer review UI for the pending-memory inbox and an honest, extractive `summarize_note`. Both build on existing layers; no new network egress and no generative backend are introduced.

### Added

- Pending-inbox parser/serializer (`src/memory/pending-inbox.ts`): the single producer of the on-disk pending-block format. `MemoryWriter.formatMemoryEntry` delegates to its `renderPendingBlock`, so the inbox round-trips (parse ⇄ render).
- Rewritten **Review Pending Memory** modal (`src/ui/pending-memory-modal.ts`): each pending entry is a card showing its resolved destination with per-entry **Apply**, **Edit & apply**, and **Discard** controls. The previous raw-file "Open inbox file" escape hatch remains.
- New `MemoryWriter.readInbox()`, `applyPending(entry)`, `discardPending(entry)` and engine `getPendingMemory()`, `applyPendingMemory(entry)`, `discardPendingMemory(entry)`. Apply **promotes** a reviewed entry by appending it into the destination memory file resolved by type/project (`resolveApplyDestination`) — project entries into that project's architecture/decisions/tasks/open-questions/overview file; global entries into `Global/preferences.md` (preference), `Global/conventions.md` (decision/architecture/task/…), or `Global/profile.md` (note/other) — then removes it from the inbox.
- Extractive `summarize_note` (`src/summarize/extractive.ts`): sentence splitting plus two ranking backends over one selection routine — lexical frequency-centrality (Luhn/centroid, always available offline) and, when an embedding provider is configured and reachable, embedding-centroid similarity with Maximal Marginal Relevance (MMR) to drop redundant near-duplicate sentences. A summary is a selection of the note's **own** sentences, returned verbatim in original order — there is no LLM/generative backend.
- New engine `summarizeNote(path, {maxSentences})` and `getNoteChunks(path)`, MCP tool `summarize_note` (default 5 sentences, max 20; rate-limited 30/min), and a new **Summarize Current Note** command.

### Security

- Apply/promotion is the human-in-the-loop counterpart to inbox-first writes, so it is intentionally **not** gated behind `allowDirectWrites` (which governs unattended/tool direct writes). It is reachable only from the desktop review UI — the local server never exposes an apply/promotion tool. It stays constrained: the destination is validated inside the memory root (`isInsideRoot`), and the write is **always** an append — it never overwrites an existing memory file, regardless of the `appendOnly` setting.
- `summarize_note` is in-scope only: it summarizes solely notes that are in the index. An excluded/unindexed note has no chunks and is refused, so a summary can never become a side channel that surfaces a note the exclusion filters were meant to keep out.
- `summarize_note` embedding is fail-open — a provider error degrades to lexical selection rather than hard-failing — and the note's sentence-units are capped (200) so one huge note cannot fan out into an unbounded embedding request.

## Milestone 3

Real embedding providers and vector + hybrid retrieval. Vector search is opt-in: the embedding provider defaults to `none`, so retrieval stays lexical and fully offline until a provider is configured. See [docs/ROADMAP.md](docs/ROADMAP.md).

### Added

- Embedding providers behind the existing `EmbeddingProvider` interface: `OllamaEmbeddingProvider` (local Ollama, batch `POST /api/embed`, no API key) and `OpenAiEmbeddingProvider` (any OpenAI-compatible `/embeddings` endpoint, `Authorization: Bearer` auth, response sorted by `index` to preserve order). A `createEmbeddingProvider` factory returns `null` — falling back to lexical — whenever required config is missing, and never throws.
- `HttpClient` boundary (`src/core/http-client.ts`) for all outbound client HTTP, with the production `ObsidianHttpClient` wrapping Obsidian's `requestUrl` (CORS-free). Providers depend only on the interface and are unit-tested with a `FakeHttpClient`; `ObsidianHttpClient` is now the second (and only other) file allowed to import `obsidian`, alongside `ObsidianVaultAdapter`.
- `EmbeddingStore` (`Index/embeddings.json`, schema `{version, model, dim, vectors}`): embeds at index time, reuses vectors whose content hash is unchanged, drops removed chunks, and recomputes everything when the backend identity changes. The identity encodes provider + model + a hash of the endpoint + a hash of the API key (secrets are hashed, never stored), so an endpoint or key swap correctly invalidates the cache. Embedding passes are single-flighted so overlapping reindex/refresh/sync cannot interleave or clobber the persisted cache. Writes go through the `VaultAdapter`, so vectors stay inside the vault.
- `VectorRetriever` (cosine similarity) and `HybridRetriever` (Reciprocal Rank Fusion, k=60, of lexical + vector) behind the existing `Retriever` interface.
- New settings: `retrievalMode` (`lexical` | `hybrid` | `vector`, default `hybrid`), `embeddingEndpoint`, `embeddingApiKey`, and `embeddingBatchSize` (default 16, clamped 1–512). Settings schema bumped v2 → v3 with a safe-default migration. Settings UI adds provider-conditional model / endpoint / API-key (password) / batch-size fields and a retrieval-mode dropdown.
- `EngramEngine.search` is now async: vector/hybrid modes embed the query first (`RetrievalQuery` gained an optional `queryVector`), while lexical mode resolves without any network call. Embedding runs at reindex/refresh time, batched by `embeddingBatchSize`.

### Security

- The embedding API key is a secret: stored locally, sent only in the `Authorization` header, and never logged (the debug logger's secret-key redaction already covers `apikey`/`api_key`).
- The OpenAI-compatible provider transmits indexed note text to a possibly-remote endpoint — a genuine data-egress consideration. It is explicit opt-in; the provider defaults to `none`, and the settings UI shows a notice on selection. Excluded/sensitive notes are never indexed, so they are never embedded or sent.
- A missing or unreachable provider degrades to lexical retrieval (fails open to offline search); vectors are never faked and a vector backend is never on the critical path.
- Outbound embedding requests enforce a timeout (`ObsidianHttpClient` races `requestUrl` against a rejecting timer, since `requestUrl` cannot be aborted), so a stalled or black-holed endpoint can never hang search or block indexing.
- Query-time identity guard: the engine only scores a query against cached vectors when their backend identity matches the active provider. After a same-dimension model/endpoint swap (or a stale-on-disk restart) it degrades to lexical rather than returning plausible-but-wrong rankings, until a re-embed catches up.
- The OpenAI-compatible provider validates that server-supplied `index` values form a proper `0..n-1` permutation before mapping vectors to chunks, so a malformed response cannot silently misattribute an embedding.
- Cached embeddings are written only inside the vault, under `Index/embeddings.json`, through the same `VaultAdapter` choke-point as the rest of the index.

## Milestone 2

Local MCP/HTTP server for Claude Code. The server is disabled by default and binds to `127.0.0.1`.

### Added

- Local MCP/HTTP server (`src/server/`) speaking JSON-RPC 2.0 MCP: `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. `local-server.ts` is the only file that touches `node:http`; auth, host/origin guards, protocol dispatch, and the tool registry live in separate, unit-tested modules (`auth.ts`, `net.ts`, `mcp-protocol.ts`, `mcp-tools.ts`).
- Server tools: `search_vault_memory`, `add_memory` (always inbox-first over the network), `get_project_context`, `get_global_context`, `list_projects`, `get_recent_sessions`, and `reindex_vault` (rate-limited with a 15s cooldown).
- New setting `server.allowNonLocalhost` (settings schema bumped to v2, with a safe-default migration): the server refuses to bind a non-localhost host unless this is enabled **and** a token is set.
- New command **Restart Local Server**; server start/stop is wired into `onload`/`onunload` and reconciled on settings changes. The control panel shows live server status (`running · host:port`).
- 67 additional Vitest tests covering token auth, host/origin guards, the tool registry and rate limiter, JSON-RPC dispatch, batch limits, and lifecycle serialization.

### Security

- Constant-time bearer-token authentication (SHA-256 digest + `timingSafeEqual`); tokens are never logged.
- DNS-rebinding protection: the `Host` header is validated against the bound address and any non-loopback `Origin` is rejected. Only a genuinely absent `Origin` passes; opaque origins (`Origin: null`) are rejected.
- Request hardening: POST-only, `Content-Type: application/json` required, a 1 MB request-body cap (413 on overflow), and a 32-message cap on JSON-RPC batches (400).
- Writes over the network are inbox-first by construction — the server never performs direct writes even when `allowDirectWrites` is enabled, and exposes no generic file access or full-vault dump.
- JSON-RPC parse and validation errors are returned as structured errors. `reindex_vault` has a 15s cooldown; `search_vault_memory` and `add_memory` have per-minute sliding-window rate limits.
- Server start/stop/restart is single-flighted so overlapping settings changes cannot bind two listeners or leak a port.

### Notes

- `summarize_note` was intentionally not implemented: honest summarization needs an LLM/embedding backend and is deferred to M3+.

## Milestone 1

First working local memory + lexical RAG layer.

### Added

- Obsidian plugin scaffold: entrypoint, manifest, settings tab, and right-sidebar control panel (with ribbon icon).
- Ten command-palette commands: Open Control Panel, Reindex Vault, Search Memory, Add Memory, Add Current Note to Project Memory, Create Project Memory Folder, Show Project Context, Review Pending Memory, Start Session Note, End Session Note.
- Safe path handling: a single `resolveInVault` choke-point that normalizes vault-relative paths and rejects absolute paths and `..` traversal.
- Configurable memory root (default `Claude Code`), validated to stay inside the vault.
- Vault scanner with included/excluded folders, excluded tags, and excluded path patterns (glob or substring).
- Heading-aware, code-fence-aware Markdown chunker that windows long sections with overlap.
- Metadata extraction (frontmatter tags/aliases/title, inline tags, wikilinks, relative Markdown links) with no YAML dependency.
- Local JSON index (`chunks.json`, `metadata.json`, `embeddings.json`) with full build, incremental mtime-based refresh, atomic persist, and load-or-rebuild.
- BM25 lexical retrieval with a heading-match boost and folder/tag/project/recency filters.
- Retriever interface so a vector retriever can slot in later without changing callers.
- `EmbeddingProvider` interface plus a deterministic mock (hash-based) provider for development and tests. No real vector retrieval yet.
- Memory model and folder scaffolding: global files (profile, preferences, conventions), per-project files, and timestamped session notes.
- Memory writer with an append-only review inbox (`pending-memory.md`) as the default write path, and double-gated direct writes.
- Settings with safe defaults (indexing on, server off, direct writes off, append-only on, debug logging off) and non-throwing settings migration.
- Debug-gated logger that redacts secrets.
- `VaultAdapter` boundary with an in-memory implementation for tests.
- Vitest test suite: chunking, metadata extraction, index build/refresh, lexical retrieval, path safety and traversal rejection, settings defaults, memory model, and memory writes.

### Security

- Local server disabled by default; binds to `127.0.0.1` when enabled (server implementation lands in M2).
- Direct memory writes disabled by default; append-only enabled by default.
- No cloud services or API keys required for the default experience.

[Unreleased]: https://github.com/nfoav8or/claude-code-engram/compare/0.2.0...HEAD
[0.2.0]: https://github.com/nfoav8or/claude-code-engram/releases/tag/0.2.0
[0.1.0]: https://github.com/nfoav8or/claude-code-engram/releases/tag/0.1.0
