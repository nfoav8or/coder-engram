# Claude Code Engram

An Obsidian-powered memory and RAG layer for Claude Code.

Claude Code Engram turns your active Obsidian vault into a local-first memory, project-context, and retrieval backend. It indexes your Markdown notes, retrieves relevant chunks for a query, and lets you capture reviewable memory entries — all stored as plain Markdown inside a `Claude Code/` folder in your vault. Nothing is written outside the vault, and no cloud API key is required.

> **Status:** Milestone 2. Local memory + lexical (BM25) retrieval (M1) and a local MCP/HTTP server that Claude Code can query and propose memory to (M2) both work today. The server is **disabled by default** and binds to `127.0.0.1`. Embedding-based vector search (Milestone 3) is **not yet implemented**. See [docs/ROADMAP.md](docs/ROADMAP.md).

## What Claude Code Engram does

- Scans your vault's Markdown notes and builds a local, rebuildable JSON index.
- Chunks notes into retrieval-friendly, heading-aware segments.
- Retrieves the most relevant chunks for a query using local BM25 lexical search — no API keys, fully offline.
- Stores structured memory (global, project, and session notes) as Markdown under `Claude Code/`.
- Captures proposed memory into a reviewable inbox (`pending-memory.md`) by default, so nothing overwrites your notes without review.
- Exposes an optional, off-by-default local MCP/HTTP server (M2) so Claude Code can search memory, propose entries (inbox-first), and read project/global context — all over localhost with constant-time token auth.

## Features (Milestone 1)

- Plugin scaffold, settings tab, and right-sidebar control panel.
- Safe path validation: every plugin path is resolved through a single choke-point that rejects absolute paths and `..` traversal.
- Vault scanner with included/excluded folders, excluded tags, and excluded path patterns (glob/substring).
- Heading-aware, code-fence-aware Markdown chunker with overlapping windows for long sections.
- Local JSON index (`chunks.json`, `metadata.json`, `embeddings.json`) with incremental refresh by mtime.
- BM25 lexical retrieval with a heading-match boost and folder/tag/project/recency filters.
- Search modal, Add Memory command, and pending-memory inbox writer (append-only by default).
- Project and session memory scaffolding.
- Deterministic mock embedding provider and an `EmbeddingProvider` interface (vector retrieval deferred to M3).
- Vitest test suite covering chunking, metadata, index build/refresh, lexical retrieval, path safety, settings defaults, and memory writes.

## Features (Milestone 2)

- **Local MCP/HTTP server** (`src/server/`) that speaks JSON-RPC 2.0 MCP (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`). Disabled by default; binds to `127.0.0.1`.
- **Constant-time token auth**: bearer tokens compared via a SHA-256 digest and `timingSafeEqual`. Tokens are never logged.
- **DNS-rebinding protection**: validates the `Host` header against the bound address and rejects any non-loopback `Origin`.
- **Request hardening**: POST-only, `Content-Type: application/json` required, and a 1 MB request-body cap.
- **Network safety**: refuses to bind a non-localhost host unless you both enable "Allow non-localhost binding" **and** set a token.
- **Curated tools** (no generic file access, no full-vault dump): `search_vault_memory`, `add_memory` (always inbox-first over the network), `get_project_context`, `get_global_context`, `list_projects`, `get_recent_sessions`, and `reindex_vault` (rate-limited, 15s cooldown).
- New **Restart Local Server** command; the control panel shows live server status (`running · host:port`).
- 67 additional Vitest tests for auth, host/origin guards, the tool registry and rate limiter, JSON-RPC dispatch, batch limits, and lifecycle serialization (172 total).

## Local server (M2)

The server is a thin `node:http` shell (`src/server/local-server.ts`) around pure, unit-tested MCP layers. It is **off by default**. To use it:

1. Set a strong **Server token** in settings.
2. Enable **Enable local server**.
3. Point Claude Code at `http://127.0.0.1:3999` (default port) with the token as a bearer credential.

Writes proposed over the network **always** go to the review inbox — the server never performs direct writes, even if **Allow direct memory writes** is enabled in the desktop settings. See [docs/MCP_SERVER.md](docs/MCP_SERVER.md) and [docs/CLAUDE_CODE_INTEGRATION.md](docs/CLAUDE_CODE_INTEGRATION.md).

## Installation (from a release)

1. Download `main.js`, `manifest.json`, and `styles.css` from a release.
2. Create the folder `<vault>/.obsidian/plugins/claude-code-engram/`.
3. Copy the three files into that folder.
4. In Obsidian: **Settings → Community plugins → Reload plugins**, then enable **Claude Code Engram**.

This is a desktop-only plugin (`isDesktopOnly: true`, minimum Obsidian 1.5.0).

## Manual installation (from source)

1. Build the plugin (see [Building](#building)).
2. Copy the build outputs — `main.js`, `manifest.json`, and `styles.css` — into:

   ```
   <vault>/.obsidian/plugins/claude-code-engram/
   ```

3. Reload plugins in Obsidian and enable **Claude Code Engram**.

## Development setup

```bash
npm install
npm run dev      # esbuild watch build
```

`npm run dev` rebuilds `main.js` on change. Point it at a test vault by copying (or symlinking) the outputs into that vault's `.obsidian/plugins/claude-code-engram/` folder. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for details.

## Building

```bash
npm run build    # typecheck + production esbuild bundle
```

Other scripts:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Watch build (development) |
| `npm run build` | Typecheck then production bundle |
| `npm run test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` | ESLint over `.ts` sources |
| `npm run typecheck` | `tsc --noEmit` |

## Configuration

Settings live under **Settings → Claude Code Engram**. Key settings and their safe defaults:

| Setting | Default | Notes |
| --- | --- | --- |
| Enable indexing | `true` | Scan and index vault notes. |
| Memory root | `Claude Code` | Vault-relative folder for all plugin-managed memory. Must stay inside the vault. |
| Included folders | *(empty)* | Allowlist; empty means the whole vault. |
| Excluded folders | *(empty)* | Folders to skip. |
| Excluded tags | *(empty)* | Notes with any of these tags are never indexed. |
| Excluded path patterns | *(empty)* | Glob (`*`, `**`) or substring patterns for sensitive notes. |
| Auto-index on file change | `false` | Debounced (~2.5s) refresh when notes change. |
| Default project | *(empty)* | Used by project-context and add-to-project commands. |
| Embedding provider | `none` | Lexical BM25 always works with `none`. Vector providers arrive in M3. |
| Embedding model | *(empty)* | Model name for the selected provider (M3). |
| Enable local server | `false` | Disabled by default. Localhost MCP/HTTP bridge for Claude Code. |
| Server host | `127.0.0.1` | Localhost only unless "Allow non-localhost binding" is on. |
| Server port | `3999` | |
| Server token | *(empty)* | Bearer token for server requests; compared in constant time. Required to bind a non-localhost host. |
| Allow non-localhost binding | `false` | Off by default. Binding a non-localhost host also requires a token. Exposes memory to your network — not recommended. |
| Allow direct memory writes | `false` | When off, all writes go to the review inbox. |
| Append-only writes | `true` | Writes only append, never overwrite. |
| Debug logging | `false` | Logs to the developer console; secrets are always redacted. |

The memory root is validated on entry: a value that would escape the vault is rejected.

## Obsidian usage

The plugin registers eleven commands (command-palette names shown):

1. **Claude Code Engram: Open Control Panel**
2. **Claude Code Engram: Reindex Vault**
3. **Claude Code Engram: Search Memory**
4. **Claude Code Engram: Add Memory**
5. **Claude Code Engram: Add Current Note to Project Memory**
6. **Claude Code Engram: Create Project Memory Folder**
7. **Claude Code Engram: Show Project Context**
8. **Claude Code Engram: Review Pending Memory**
9. **Claude Code Engram: Start Session Note**
10. **Claude Code Engram: End Session Note**
11. **Claude Code Engram: Restart Local Server**

The **Control Panel** (right sidebar, also on the ribbon "brain-circuit" icon) shows the memory root, indexed-note and chunk counts, last-indexed time, and server status, plus quick buttons: Reindex, Search, Add memory, Review inbox, New project, Project context.

## Claude Code usage

Programmatic access from Claude Code runs over the local MCP/HTTP server (M2), which is **disabled by default**. Once you set a token and enable it, Claude Code can search memory, propose entries (inbox-first), and read project/global context. You can still use the plugin entirely through Obsidian commands and by reading/writing the Markdown memory folder yourself.

See [docs/MCP_SERVER.md](docs/MCP_SERVER.md) for the server design and [docs/CLAUDE_CODE_INTEGRATION.md](docs/CLAUDE_CODE_INTEGRATION.md) for the workflow and an MCP config example.

## Memory folder structure

All plugin-managed memory lives under the configured root (default `Claude Code/`):

```
Claude Code/
  Memory/
    Global/
      profile.md
      preferences.md
      conventions.md
    Projects/
      <project-name>/
        overview.md
        architecture.md
        decisions.md
        tasks.md
        open-questions.md
        sessions/
          YYYY-MM-DD-HHMM.md
    Inbox/
      pending-memory.md
  Index/
    chunks.json
    metadata.json
    embeddings.json
  Config/
    plugin-settings-backup.json
```

Markdown files are the durable source of truth; the JSON files under `Index/` are a rebuildable cache. See [docs/MEMORY_MODEL.md](docs/MEMORY_MODEL.md).

## Security model

- Everything the plugin reads or writes stays inside the vault. `resolveInVault` is the single path choke-point and rejects absolute paths and `..` traversal.
- Proposed memory goes to the append-only review inbox by default. Direct writes to memory files are double-gated (require an explicit setting and stay inside the memory root).
- The local server is disabled by default, binds to `127.0.0.1`, uses constant-time bearer-token auth, and applies DNS-rebinding (Host/Origin) guards. It refuses to bind a non-localhost host unless you both allow it and set a token. Server writes are always inbox-first, and no generic file access or full-vault dump is exposed.
- Debug logging is off by default and redacts secrets when on.

Full details: [docs/SECURITY.md](docs/SECURITY.md).

## Limitations

- **Lexical-only retrieval.** Retrieval is BM25 keyword search. Embedding/vector and hybrid retrieval are not implemented yet (M3). The `mock`, `ollama`, and `openai-compatible` provider options appear in settings but do not yet affect retrieval.
- **No `summarize_note` tool.** Honest note summarization needs an LLM/embedding backend, so it is deferred to M3+ rather than shipped as a stub.
- **Desktop only.** `isDesktopOnly: true`.
- Binary attachments are not indexed.

## Roadmap

- **M1 (done):** local memory + lexical RAG.
- **M2 (done):** control-panel polish, project creation, local MCP/HTTP server with constant-time token auth and DNS-rebinding guards, curated inbox-first tools, Claude Code integration docs.
- **M3:** embedding providers (Ollama, OpenAI-compatible), vector + hybrid retrieval, richer review UI, and honest note summarization.

Details: [docs/ROADMAP.md](docs/ROADMAP.md).

## License

MIT. See [LICENSE](LICENSE).
