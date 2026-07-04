# Roadmap

Claude Code Engram is built in five milestones. Milestones 1 through 5 are complete; further work is tracked under "Deferred / future" below.

## Milestone 1 — local memory + lexical RAG (done)

- Plugin scaffold, settings tab, and control panel.
- Safe path validation (`resolveInVault` choke-point).
- Vault scanner with folder/tag/path-pattern filters.
- Heading- and code-fence-aware Markdown chunker with overlapping windows.
- Local JSON index with incremental mtime-based refresh and atomic persist.
- BM25 lexical retrieval with heading boost and folder/tag/project/recency filters.
- Search modal, Add Memory command, and append-only pending-memory inbox writer.
- Global / project / session memory scaffolding.
- `EmbeddingProvider` interface plus a deterministic mock (no real vector retrieval yet).
- Vitest test suite.

## Milestone 2 — server + integration (done)

- Control-panel polish and project-creation workflow refinements; live server status (`running · host:port`) and a **Restart Local Server** command.
- Local MCP/HTTP server (`src/server/`) speaking JSON-RPC 2.0 MCP (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`):
  - Disabled by default, binds to `127.0.0.1`, configurable port.
  - Constant-time bearer-token authentication (SHA-256 digest + `timingSafeEqual`), with request validation.
  - DNS-rebinding protection (Host/Origin guards), POST-only, JSON content-type required, and a 1 MB body cap.
  - New `server.allowNonLocalhost` setting (schema v2): binding a non-localhost host requires both this flag and a token.
  - Tools: `search_vault_memory`, `add_memory`, `get_project_context`, `get_global_context`, `list_projects`, `get_recent_sessions`, `reindex_vault` (rate-limited). See [MCP_SERVER.md](MCP_SERVER.md).
  - Inbox-first writes over the network by construction; the server never performs direct writes and exposes no generic file access or full-vault dump.
- Claude Code integration documentation and example MCP configuration (see [CLAUDE_CODE_INTEGRATION.md](CLAUDE_CODE_INTEGRATION.md)).

## Milestone 3 — embeddings + hybrid retrieval (done)

- Real embedding providers behind the existing `EmbeddingProvider` interface: `OllamaEmbeddingProvider` (local Ollama, no API key) and `OpenAiEmbeddingProvider` (any OpenAI-compatible `/embeddings` endpoint). A `createEmbeddingProvider` factory returns `null` (lexical fallback) when config is missing and never throws.
- New `HttpClient` boundary (`core/http-client.ts`) for all outbound client HTTP, with the production `ObsidianHttpClient` wrapping Obsidian's `requestUrl`. Providers stay Obsidian-free and unit-testable; this is the second file (with `ObsidianVaultAdapter`) permitted to import `obsidian`.
- Populated `Index/embeddings.json` via `EmbeddingStore`: incremental, content-hash-keyed vector cache written through the `VaultAdapter`.
- `VectorRetriever` (cosine) and `HybridRetriever` (Reciprocal Rank Fusion of lexical + vector) behind the existing `Retriever` interface, selected by the new `retrievalMode` setting (default `hybrid`). Settings schema bumped v2 → v3; `EngramEngine.search` became async to embed the query when needed.
- Degrades to lexical whenever the provider is `none` or unavailable — vectors are never on the critical path.

## Milestone 4 — review UI + honest summarization (done)

- Richer **Review Pending Memory** UI: each pending inbox entry is a card showing its resolved destination with per-entry **Apply**, **Edit & apply**, and **Discard** controls (`src/ui/pending-memory-modal.ts`); the raw "Open inbox file" escape hatch remains. A single pending-block parser/serializer (`src/memory/pending-inbox.ts`) is now the only producer of the on-disk inbox format, so entries round-trip (parse ⇄ render).
- **Apply promotes** a reviewed entry by appending it into the destination memory file resolved by type/project (`resolveApplyDestination`), then removes it from the inbox. New `MemoryWriter.readInbox`/`applyPending`/`discardPending` and engine `getPendingMemory`/`applyPendingMemory`/`discardPendingMemory`. Promotion is UI-only (never server-exposed), always append-only, and validated inside the memory root; it is deliberately not gated by `allowDirectWrites`. See [SECURITY.md](SECURITY.md).
- Honest **extractive** `summarize_note` (`src/summarize/extractive.ts`): it selects the note's own sentences (returned verbatim, in original order) via lexical frequency-centrality offline, or embedding-centroid similarity with MMR when an embedding provider is reachable. No LLM/generative backend was added — embeddings only improve selection and are not required. New engine `summarizeNote`/`getNoteChunks`, MCP tool `summarize_note` (default 5, max 20 sentences; rate-limited 30/min), and a **Summarize Current Note** command. It summarizes only in-index notes and fails open to lexical. See [MCP_SERVER.md](MCP_SERVER.md).

## Milestone 5 — CI + release/packaging (done)

- GitHub Actions CI workflow (`.github/workflows/ci.yml`) running typecheck, tests, lint, and the production build on push/PR.
- Release workflow (`.github/workflows/release.yml`) that builds and publishes the plugin artifacts (`main.js`, `manifest.json`, `styles.css`).
- Version-bump tooling (`version-bump.mjs`) to keep `manifest.json`, `versions.json`, and `package.json` in sync for tagged releases.

## Deferred / future

- Non-desktop support (currently `isDesktopOnly`).
- Indexing of binary attachments.
- Alternative local vector stores (SQLite, LanceDB, DuckDB) behind the storage model.
