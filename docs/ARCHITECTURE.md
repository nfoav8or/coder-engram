# Architecture

Claude Code Engram is a layered TypeScript Obsidian plugin. The guiding rule is that the service and core layers never import `obsidian` directly: they reach the outside world through narrow injected boundaries — `VaultAdapter` for the file system and (from M3) `HttpClient` for outbound requests. Only the UI layer and those two thin adapter shells (`ObsidianVaultAdapter`, `ObsidianHttpClient`) touch a host API. That keeps the indexing, retrieval, and memory logic Obsidian-agnostic and unit-testable, and it lets the local server (M2) reuse the same `EngramEngine` verbatim.

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│ UI layer (imports `obsidian`)                                │
│   main.ts · settings/settings-tab.ts                         │
│   ui/control-panel-view.ts · ui/*-modal.ts                   │
└───────────────┬─────────────────────────────────────────────┘
                │ (only via EngramEngine + plain data)
┌───────────────▼─────────────────────────────────────────────┐
│ Service layer (Obsidian-agnostic)                            │
│   engine.ts (EngramEngine — orchestration facade)            │
│   indexing/IndexManager · retrieval/Retriever                │
│   memory/MemoryStore · memory/MemoryWriter                   │
│   indexing/VaultScanner · memory/ProjectMemory               │
└───────────────┬─────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────┐
│ Core utils (pure, no I/O framework)                          │
│   utils/paths · core/markdown-chunker                        │
│   core/metadata-extractor · retrieval/ranking                │
│   utils/logger · utils/errors · utils/validation             │
└───────────────┬─────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────┐
│ VaultAdapter boundary (core/vault-adapter.ts)                │
│   ObsidianVaultAdapter (prod) · InMemoryVaultAdapter (tests) │
└─────────────────────────────────────────────────────────────┘
```

The **server layer** (`server/`, added in Milestone 2) sits beside the UI layer: it drives the same `EngramEngine` through a local, token-authenticated MCP/HTTP endpoint. Like the UI layer, only its thin socket shell (`local-server.ts`) imports a host API — in its case `node:http`, not `obsidian`.

## Server layer (M2)

An optional, off-by-default local server that exposes a curated MCP tool set to Claude Code. It mirrors the "thin shell + pure core" discipline of the `VaultAdapter` boundary — everything security-relevant is testable without a socket:

- `server/local-server.ts` — the only file importing `node:http`. Owns binding (localhost by default; non-loopback refused without an explicit opt-in **and** a token), request hardening (POST-only, JSON content-type, 1 MB body cap), DNS-rebinding guards, auth, and the start/stop lifecycle.
- `server/mcp-protocol.ts` — pure JSON-RPC 2.0 dispatch for the MCP methods (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`).
- `server/mcp-tools.ts` — the tool registry and handlers over `EngramEngine`, argument validation, and a `RateLimiter`. Network writes are inbox-only.
- `server/auth.ts` — bearer-token extraction and constant-time comparison.
- `server/net.ts` — loopback detection and Host/Origin validation.

The plugin (`main.ts`) reconciles the server with settings on load, on settings change, and on unload. See [MCP_SERVER.md](MCP_SERVER.md) and [SECURITY.md](SECURITY.md).

## UI layer

- `main.ts` (`EngramPlugin`) — the Obsidian `Plugin` subclass. It loads/migrates settings, constructs an `ObsidianVaultAdapter` and an `EngramEngine`, registers the commands, the control-panel view, the ribbon icon, the settings tab, debounced file-change watchers, and (in M2) reconciles the local server on load/settings-change/unload. It implements the `SettingsHost` and `ControlPanelActions` interfaces so the settings tab and control panel stay decoupled (no import cycles).
- `settings/settings-tab.ts` — renders the settings UI, validates the memory root on entry, and carries the server security warning.
- `ui/control-panel-view.ts` — a right-sidebar `ItemView` showing index stats and quick-action buttons. It talks to `main.ts` only through the `ControlPanelActions` interface.
- `ui/*-modal.ts` — `SearchModal`, `AddMemoryModal`, `PendingMemoryModal`, and the small `PromptModal` / `TextDisplayModal` helpers.

These modules import `obsidian`. Nothing below this layer does.

## Service layer

- `engine.ts` — `EngramEngine` is the orchestration facade shared by UI commands (and, in M2, the server). It owns the scanner, index manager, memory store, memory writer, and retriever, and rebuilds them whenever settings change. It depends only on a `VaultAdapter`, a settings object, and a `Logger`.
- `indexing/vault-scanner.ts` — `VaultScanner` enumerates eligible Markdown notes and applies folder/tag/pattern filters.
- `indexing/index-manager.ts` — `IndexManager` builds, incrementally refreshes, persists, and loads the JSON index.
- `indexing/link-graph.ts` — pure wikilink-graph resolution over indexed chunks (backs the `find_related_notes` tool).
- `retrieval/retriever.ts` + `retrieval/lexical-retriever.ts` — the `Retriever` interface and the M1 BM25 `LexicalRetriever`.
- `memory/memory-store.ts` — `MemoryStore` handles read-side context (global/project/sessions) and non-destructive scaffold creation.
- `memory/memory-writer.ts` — `MemoryWriter` is the only component that writes memory: inbox proposals and double-gated direct writes.
- `memory/project-memory.ts` — `ProjectMemory` scaffolds and enumerates per-project folders and session notes.

## Core utils

Pure, dependency-light modules with no Obsidian imports:

- `utils/paths.ts` — path normalization and the `resolveInVault` / `isInsideRoot` safety functions.
- `core/markdown-chunker.ts` — heading- and fence-aware chunking.
- `core/metadata-extractor.ts` — frontmatter/tag/link extraction with no YAML dependency.
- `retrieval/ranking.ts` — tokenization, structural filtering, and snippet building shared by retrievers.
- `utils/logger.ts` — debug-gated logger with secret redaction.
- `utils/errors.ts` — typed errors (`PathSecurityError`, `ConfigError`, …).
- `utils/validation.ts`, `utils/debounce.ts` — small helpers.

## VaultAdapter boundary

`core/vault-adapter.ts` defines the `VaultAdapter` interface — the single boundary between the plugin and Obsidian's file system. It exposes `read`, `write`, `append`, `exists`, `ensureFolder`, `listMarkdownFiles`, and `getMtime`, all operating on validated vault-relative paths. As defense-in-depth, every adapter method calls `assertRelative` and refuses absolute paths.

Two implementations:

- `ObsidianVaultAdapter` (`core/obsidian-vault-adapter.ts`) — the production adapter backed by Obsidian's `Vault` API.
- `InMemoryVaultAdapter` (in `vault-adapter.ts`) — a flat path→content map used throughout the test suite.

Because the whole service layer depends on this interface rather than on `obsidian`, the tests exercise real indexing/retrieval/memory logic without a running Obsidian.

## Dependency direction

Dependencies point **downward only**: UI → service → core utils → `VaultAdapter` / `HttpClient`. The service and core layers never import `obsidian`, and lower layers never import upward. Embedding providers (`embeddings/`) are injected where needed and stay off the critical path — retrieval works with no provider.

## Embeddings & vector retrieval (M3)

Milestone 3 adds real embedding providers and vector/hybrid retrieval without disturbing the layering. Two seams make this possible.

**A second adapter shell — the `HttpClient` boundary.** `core/http-client.ts` defines the `HttpClient` interface for all *outbound* client HTTP, mirroring the `VaultAdapter` pattern. The embedding providers depend only on this interface, so they stay Obsidian-free and unit-testable against a `FakeHttpClient` (also in `http-client.ts`). The production implementation, `ObsidianHttpClient` (`core/obsidian-http-client.ts`), wraps Obsidian's `requestUrl` — CORS-free and usable in the Electron renderer. It is the *second* file permitted to import `obsidian`, alongside `ObsidianVaultAdapter`. (The M2 local server is an inbound listener over `node:http` and is unrelated to this outbound path.)

**Providers behind a factory.** `embeddings/embedding-provider.ts` defines the `EmbeddingProvider` interface and a `cosineSimilarity` helper. Implementations: `mock-embedding-provider.ts` (deterministic hash-based, for tests), `ollama-provider.ts` (`OllamaEmbeddingProvider`, local, no API key), and `openai-embedding-provider.ts` (`OpenAiEmbeddingProvider`, any OpenAI-compatible endpoint, bearer-key auth). `provider-factory.ts`'s `createEmbeddingProvider` builds the configured provider or returns `null` when required config is missing — the graceful-degrade signal for lexical fallback; it never throws.

**Vector cache — `EmbeddingStore`.** `embeddings/embedding-store.ts` owns `Index/embeddings.json` with the shape `{version, model, dim, vectors: { <chunkId>: {h: contentHash, v: number[]} }}`. `embedIndex` reuses vectors whose content hash is unchanged, drops removed chunks, and recomputes everything when the provider identity (`<id>:<model>`) changes; it batches embedding calls and persists once at the end. All writes go through the `VaultAdapter`, so the cache never leaves the vault.

**Retrievers behind the existing interface.** `retrieval/vector-retriever.ts` (`VectorRetriever`, cosine similarity over the stored vectors) and `retrieval/hybrid-retriever.ts` (`HybridRetriever`, Reciprocal Rank Fusion with k=60 of the lexical and vector rankings) both implement the M1 `Retriever` interface, so callers are unchanged. The active retriever is chosen by the `retrievalMode` setting (`lexical` | `hybrid` | `vector`); `EngramEngine.effectiveMode()` forces lexical whenever no usable provider exists, so a missing or unreachable backend degrades cleanly.

**The async-search seam.** Vector and hybrid ranking need a query embedding, which requires a network round-trip — so `EngramEngine.search` became `async`. `RetrievalQuery` gained an optional `queryVector`; the engine embeds the query (via `withQueryVector`) only when the effective mode is non-lexical, a provider exists, and vectors are already stored, and it falls back to lexical ranking if that embedding call fails. The retrievers themselves stay synchronous: they receive the pre-computed `queryVector` and never touch the network. Embedding of the *index* happens at reindex/refresh time through `embedIndex`, which first checks `provider.isAvailable()` and otherwise logs and keeps lexical retrieval.

## Review UI & summarization (M4)

Milestone 4 adds two small pieces, both without new host boundaries.

**Single inbox-format producer — `memory/pending-inbox.ts`.** This pure module parses and serializes `Memory/Inbox/pending-memory.md`. Its `renderPendingBlock` is now the *only* place the on-disk pending-block format is produced — `MemoryWriter.formatMemoryEntry` delegates to it — so proposing, reading, and re-rendering an entry round-trips (parse ⇄ render). `MemoryWriter` gains `readInbox`, `applyPending`, and `discardPending`; applying an entry resolves a destination memory file by type/project (`resolveApplyDestination`) and **appends** it (never overwriting, inside the memory root), then removes it from the inbox. This promotion path is exposed only through the desktop `PendingMemoryModal` (via `EngramEngine.getPendingMemory` / `applyPendingMemory` / `discardPendingMemory`) — never through the server.

**Summarization layer — `summarize/`.** `summarize/extractive.ts` is a pure module that splits a note into sentence-units and ranks them with two backends sharing one selection routine: lexical frequency-centrality (Luhn/centroid, always available offline) and, when an embedding provider is configured and reachable, embedding-centroid similarity with Maximal Marginal Relevance (MMR) to avoid redundant near-duplicate sentences. It is **extractive** — the result is a subset of the note's own sentences, returned verbatim in original order, with no generative backend. `EngramEngine.summarizeNote` drives it over a note's indexed chunks (`getNoteChunks`); it operates only on in-index notes (an unindexed note has no chunks and is refused), caps sentence-units at 200, and degrades to lexical selection if embedding fails. It surfaces as the **Summarize Current Note** command and the `summarize_note` MCP tool.
