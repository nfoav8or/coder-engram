# Roadmap

Claude Code Engram is built in three milestones. Milestone 1 is complete; Milestones 2 and 3 are planned.

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

## Milestone 2 — server + integration

- Control-panel polish and project-creation workflow refinements.
- Local MCP/HTTP server:
  - Disabled by default, binds to `127.0.0.1`, configurable port.
  - Optional token authentication with request-payload validation.
  - Tools including `search_vault_memory` and `add_memory` (see [MCP_SERVER.md](MCP_SERVER.md) for the full planned tool list).
  - Inbox-first writes; direct writes only when explicitly enabled.
- Claude Code integration documentation and example MCP configuration (see [CLAUDE_CODE_INTEGRATION.md](CLAUDE_CODE_INTEGRATION.md)).

## Milestone 3 — embeddings + hybrid retrieval

- Real embedding providers behind the existing `EmbeddingProvider` interface: Ollama (local) and OpenAI-compatible.
- Vector retrieval and hybrid (lexical + vector) ranking behind the existing `Retriever` interface.
- Populated `embeddings.json` and ranking improvements.
- Richer review UI for the pending-memory inbox.

## Deferred / future

- Non-desktop support (currently `isDesktopOnly`).
- Indexing of binary attachments.
- Alternative local vector stores (SQLite, LanceDB, DuckDB) behind the storage model.
