# Changelog

All notable changes to Claude Code Engram are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — Milestone 2

Local MCP/HTTP server for Claude Code. The server is disabled by default and binds to `127.0.0.1`. Milestone 3 (embedding providers, vector and hybrid retrieval) is still planned. See [docs/ROADMAP.md](docs/ROADMAP.md).

### Added

- Local MCP/HTTP server (`src/server/`) speaking JSON-RPC 2.0 MCP: `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. `local-server.ts` is the only file that touches `node:http`; auth, host/origin guards, protocol dispatch, and the tool registry live in separate, unit-tested modules (`auth.ts`, `net.ts`, `mcp-protocol.ts`, `mcp-tools.ts`).
- Server tools: `search_vault_memory`, `add_memory` (always inbox-first over the network), `get_project_context`, `get_global_context`, `list_projects`, `get_recent_sessions`, and `reindex_vault` (rate-limited with a 15s cooldown).
- New setting `server.allowNonLocalhost` (settings schema bumped to v2, with a safe-default migration): the server refuses to bind a non-localhost host unless this is enabled **and** a token is set.
- New command **Restart Local Server**; server start/stop is wired into `onload`/`onunload` and reconciled on settings changes. The control panel shows live server status (`running · host:port`).
- 67 additional Vitest tests covering token auth, host/origin guards, the tool registry and rate limiter, JSON-RPC dispatch, batch limits, and lifecycle serialization (172 tests total).

### Security

- Constant-time bearer-token authentication (SHA-256 digest + `timingSafeEqual`); tokens are never logged.
- DNS-rebinding protection: the `Host` header is validated against the bound address and any non-loopback `Origin` is rejected. Only a genuinely absent `Origin` passes; opaque origins (`Origin: null`) are rejected.
- Request hardening: POST-only, `Content-Type: application/json` required, a 1 MB request-body cap (413 on overflow), and a 32-message cap on JSON-RPC batches (400).
- Writes over the network are inbox-first by construction — the server never performs direct writes even when `allowDirectWrites` is enabled, and exposes no generic file access or full-vault dump.
- JSON-RPC parse and validation errors are returned as structured errors. `reindex_vault` has a 15s cooldown; `search_vault_memory` and `add_memory` have per-minute sliding-window rate limits.
- Server start/stop/restart is single-flighted so overlapping settings changes cannot bind two listeners or leak a port.

### Notes

- `summarize_note` was intentionally not implemented: honest summarization needs an LLM/embedding backend and is deferred to M3+.

## [0.1.0] — Milestone 1

Early, unreleased version. First working local memory + lexical RAG layer.

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

[Unreleased]: https://example.com/compare/v0.1.0...HEAD
[0.1.0]: https://example.com/releases/v0.1.0
