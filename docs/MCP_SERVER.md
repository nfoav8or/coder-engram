# MCP / local server

> **Status: Planned for Milestone 2 — not yet implemented.**
>
> There is no server binary in the current build. The settings tab shows server options (enable toggle, host, port, token) and a security warning, but toggling them has no runtime effect yet: the plugin does not open a network listener in Milestone 1. This document describes the intended design so the settings and security model are clear ahead of implementation.

## Goals

Expose the vault's memory to Claude Code through a small, local, authenticated bridge — without granting arbitrary file access and without leaving the machine.

## Planned design

- **Localhost bind.** Binds to `127.0.0.1` by default. Binding to any non-localhost address requires an explicit change and surfaces a warning, because it exposes memory to the local network.
- **Configurable port.** Default `3999` (validated to 1–65535).
- **Optional token auth.** A configured token is required on every request. The token is stored in settings and is always redacted from logs.
- **Disabled by default.** The server does not start unless you explicitly enable it, and it should be enabled only while needed.
- **Inbox-first writes.** Write tools append to `Memory/Inbox/pending-memory.md` for review. Direct writes require the separate `allowDirectWrites` setting and still cannot escape the memory root.
- **Payload validation.** Every tool request is validated before it touches the engine. No tool exposes arbitrary file read/write, and the full vault is never returned wholesale — only query-scoped retrieval.
- **Debounced/rate-limited** expensive operations (for example reindexing) where practical.
- **Reuses `EngramEngine`.** The server drives the same Obsidian-agnostic engine the UI uses, so retrieval and write semantics are identical.

## Planned tools

| Tool | Purpose |
| --- | --- |
| `search_vault_memory` | Query-scoped retrieval over the index (returns chunks with paths, headings, snippets). |
| `add_memory` | Propose a memory entry (to the inbox by default). |
| `get_project_context` | Concatenated project memory (overview → architecture → decisions → tasks → open questions). |
| `get_global_context` | Concatenated global memory (profile + preferences + conventions). |
| `propose_memory_update` | Propose a reviewable memory update to the inbox. |
| `list_projects` | Enumerate project names under the projects root. |
| `get_recent_sessions` | Most recent session notes for a project. |
| `get_decisions` | The project decision log. |
| `get_open_questions` | The project open-questions list. |
| `get_action_items` | Outstanding action items. |
| `reindex_vault` | Trigger an index rebuild. |

`search_vault_memory` and `add_memory` are the minimum viable set for Milestone 2; the remaining tools build on the same engine methods (several of which already exist: `getProjectContext`, `getGlobalContext`, `listProjects`, `getRecentSessions`, `addMemory`, `reindex`).

## Security summary

See [SECURITY.md](SECURITY.md). In short: off by default, localhost-bound, token-gated, inbox-first writes, no arbitrary file access, secrets redacted in logs.
