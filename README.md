# Claude Code Engram

An Obsidian-powered memory and RAG layer for Claude Code.

Claude Code Engram turns your active Obsidian vault into a local-first memory, project-context, and retrieval backend. It indexes your Markdown notes, retrieves relevant chunks for a query, and lets you capture reviewable memory entries — all stored as plain Markdown inside a `Claude Code/` folder in your vault. Nothing is written outside the vault, and no cloud API key is required.

> **Status:** Milestone 1. Local memory + lexical (BM25) retrieval work today. The local MCP/HTTP server (Milestone 2) and embedding-based vector search (Milestone 3) are **not yet implemented**. See [docs/ROADMAP.md](docs/ROADMAP.md).

## What Claude Code Engram does

- Scans your vault's Markdown notes and builds a local, rebuildable JSON index.
- Chunks notes into retrieval-friendly, heading-aware segments.
- Retrieves the most relevant chunks for a query using local BM25 lexical search — no API keys, fully offline.
- Stores structured memory (global, project, and session notes) as Markdown under `Claude Code/`.
- Captures proposed memory into a reviewable inbox (`pending-memory.md`) by default, so nothing overwrites your notes without review.

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
| Enable local server | `false` | Disabled by default. Localhost bridge arrives in M2. |
| Server host | `127.0.0.1` | Localhost only. |
| Server port | `3999` | |
| Server token | *(empty)* | Auth token for server requests (M2). |
| Allow direct memory writes | `false` | When off, all writes go to the review inbox. |
| Append-only writes | `true` | Writes only append, never overwrite. |
| Debug logging | `false` | Logs to the developer console; secrets are always redacted. |

The memory root is validated on entry: a value that would escape the vault is rejected.

## Obsidian usage

The plugin registers ten commands (command-palette names shown):

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

The **Control Panel** (right sidebar, also on the ribbon "brain-circuit" icon) shows the memory root, indexed-note and chunk counts, last-indexed time, and server status, plus quick buttons: Reindex, Search, Add memory, Review inbox, New project, Project context.

## Claude Code usage

Programmatic access from Claude Code depends on the local MCP/HTTP server, which is **planned for Milestone 2 and not yet implemented**. Today you use the plugin through Obsidian commands and read/write the Markdown memory folder yourself.

See [docs/MCP_SERVER.md](docs/MCP_SERVER.md) for the planned server design and [docs/CLAUDE_CODE_INTEGRATION.md](docs/CLAUDE_CODE_INTEGRATION.md) for the current workflow and a forward-looking MCP config example.

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
- The local server is disabled by default, binds to `127.0.0.1`, and will use token auth (M2).
- Debug logging is off by default and redacts secrets when on.

Full details: [docs/SECURITY.md](docs/SECURITY.md).

## Limitations

- **Lexical-only retrieval in M1.** Retrieval is BM25 keyword search. Embedding/vector and hybrid retrieval are not implemented yet (M3). The `mock`, `ollama`, and `openai-compatible` provider options appear in settings but do not yet affect retrieval.
- **No server yet.** There is no MCP/HTTP endpoint; Claude Code cannot connect programmatically until M2.
- **Desktop only.** `isDesktopOnly: true`.
- Binary attachments are not indexed.

## Roadmap

- **M1 (done):** local memory + lexical RAG.
- **M2:** control-panel polish, project creation, local MCP/HTTP server with token auth, Claude Code integration docs.
- **M3:** embedding providers (Ollama, OpenAI-compatible), vector + hybrid retrieval, richer review UI.

Details: [docs/ROADMAP.md](docs/ROADMAP.md).

## License

MIT. See [LICENSE](LICENSE).
