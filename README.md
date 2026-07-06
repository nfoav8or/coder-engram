# Claude Code Engram

Safe, reviewable memory for Claude Code — stored as plain Markdown in your own vault.

**Claude Code Engram is the safe memory layer for Claude Code.** It turns your Obsidian vault into persistent, structured memory an AI coding agent can search and *propose to* — but every agent-written memory lands in a review inbox you approve or discard, so nothing is ever silently written to or edited in your notes. Everything is plain Markdown inside a `Claude Code/` folder in your vault; the retrieval index is a rebuildable local cache. No cloud API key is required for the default experience, and the optional local server is off by default, binds `127.0.0.1`, and is token-authenticated.

## What makes it different

Most Obsidian ↔ AI plugins are either a chat panel or a bridge that hands an agent broad read/write/edit access to your notes. Engram is neither:

- **Human-in-the-loop writes.** The agent *proposes*; you review. Direct edit, delete, and overwrite are never exposed to it — so an agent can't surgically rewrite (or quietly corrupt) your notes.
- **Durable agent memory, not a chatbot.** Structured global / project / session memory that accumulates across Claude Code runs and is captured for review — not an ephemeral chat.
- **Hardened by default.** Server off by default, localhost-only, constant-time token auth, DNS-rebinding guards, a curated tool surface, and no generic file access or full-vault dump.
- **Local-first, no lock-in.** Markdown is the source of truth; embeddings are opt-in (default is fully-offline lexical search); no cloud key for the default experience.

> **Status:** v0.4.0 (Milestones 1–8). Local memory + lexical (BM25) retrieval (M1), a local MCP/HTTP server that Claude Code can query and propose memory to (M2), embedding-based vector + hybrid retrieval (M3), a richer pending-memory review UI plus an honest extractive `summarize_note` (M4), CI + release packaging (M5), and retrieval-quality polish — precise chunk line spans with open-at-line, densest-window snippets, per-note result diversity, and a ~7× faster lexical query path (M6). M7 deepens the Claude Code memory loop: a `get_note_context` tool to read a hit's full passage, `find_related_notes` link-graph navigation, and `add_memory` de-duplication so a looping agent can't flood the review inbox. M8 sharpens it: ranged reads (`startLine`/`endLine`), dated + de-duplicated + backfilled search pages, a `[PENDING REVIEW]` label on unreviewed inbox hits, output caps and rate limits on the session-priming tools, O(changed) refresh I/O, and an embedding-settings fix that removes the need for a plugin reload. The server is **disabled by default** and binds to `127.0.0.1`. Vector retrieval is **disabled by default** too: the embedding provider defaults to `none`, so search stays fully offline and lexical until you point it at a local Ollama or an OpenAI-compatible endpoint. See [docs/ROADMAP.md](docs/ROADMAP.md).

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
- Deterministic mock embedding provider and an `EmbeddingProvider` interface (real providers and vector retrieval landed in M3).
- Vitest test suite covering chunking, metadata, index build/refresh, lexical retrieval, path safety, settings defaults, and memory writes.

## Features (Milestone 2)

- **Local MCP/HTTP server** (`src/server/`) that speaks JSON-RPC 2.0 MCP (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`). Disabled by default; binds to `127.0.0.1`.
- **Constant-time token auth**: bearer tokens compared via a SHA-256 digest and `timingSafeEqual`. Tokens are never logged.
- **DNS-rebinding protection**: validates the `Host` header against the bound address and rejects any non-loopback `Origin`.
- **Request hardening**: POST-only, `Content-Type: application/json` required, and a 1 MB request-body cap.
- **Network safety**: refuses to bind a non-localhost host unless you both enable "Allow non-localhost binding" **and** set a token.
- **Curated tools** (no generic file access, no full-vault dump): `search_vault_memory`, `get_note_context` (full indexed text of one note, passage by passage — the follow-up to a search hit), `find_related_notes` (link-graph neighbours of an indexed note), `add_memory` (always inbox-first over the network), `get_project_context`, `get_global_context`, `list_projects`, `get_recent_sessions`, and `reindex_vault` (rate-limited, 15s cooldown).
- New **Restart Local Server** command; the control panel shows live server status (`running · host:port`).
- 67 additional Vitest tests for auth, host/origin guards, the tool registry and rate limiter, JSON-RPC dispatch, batch limits, and lifecycle serialization.

## Features (Milestone 3)

- **Real embedding providers** behind the existing `EmbeddingProvider` interface: `OllamaEmbeddingProvider` (local Ollama, no API key) and `OpenAiEmbeddingProvider` (any OpenAI-compatible `/embeddings` endpoint). Selected via the **Embedding provider** setting; the default `none` keeps search lexical and fully offline.
- **Outbound HTTP boundary** (`src/core/http-client.ts`): all client networking goes through an injected `HttpClient`, whose production implementation (`ObsidianHttpClient`) wraps Obsidian's `requestUrl` (CORS-free). Providers stay Obsidian-free and unit-testable via a `FakeHttpClient`. This is the only other service file allowed to import `obsidian`, alongside `ObsidianVaultAdapter`.
- **Vector cache** (`Index/embeddings.json`): the `EmbeddingStore` embeds at index time, reusing vectors whose content hash is unchanged, dropping removed chunks, and recomputing everything when the provider identity changes. Writes go through the `VaultAdapter`, so vectors stay inside the vault.
- **Vector and hybrid retrieval** behind the existing `Retriever` interface: cosine-similarity `VectorRetriever` and a `HybridRetriever` that fuses lexical and vector rankings with Reciprocal Rank Fusion. A new **Retrieval mode** setting picks `lexical`, `hybrid` (default), or `vector`.
- **Graceful degradation:** with provider `none`, or when a configured provider is unreachable, retrieval is always lexical. Vectors are never faked, and a vector backend is never on the critical path.
- Expanded Vitest suite covering the new providers, the HTTP boundary, embedding store, and vector/hybrid retrievers.

## Features (Milestone 4)

- **Richer pending-memory review UI**: the **Review Pending Memory** modal now shows each pending entry as a card with its resolved destination and per-entry **Apply**, **Edit & apply**, and **Discard** buttons, instead of dumping the raw inbox file (the "Open inbox file" escape hatch remains). **Apply promotes** the entry by appending it into the destination memory file (a project's overview/architecture/decisions/tasks/open-questions file, or `Global/preferences.md` / `conventions.md` / `profile.md`) and removes it from the inbox. A single parser/serializer (`src/memory/pending-inbox.ts`) is now the only producer of the on-disk inbox format, so entries round-trip. Promotion is desktop-UI-only (never exposed over the network), always append-only, and validated inside the memory root — see [docs/SECURITY.md](docs/SECURITY.md).
- **Honest, extractive `summarize_note`**: a new **Summarize Current Note** command and MCP tool that returns a selection of the note's **own sentences** — verbatim, in original order — never generated prose. It ranks sentences by lexical frequency-centrality offline, or by embedding-centroid similarity with Maximal Marginal Relevance (MMR) when an embedding provider is reachable. There is **no LLM/generative backend**; embeddings only improve selection and are not required. It summarizes only notes that are in the index (excluded notes are refused) and fails open to lexical if embedding errors. Default 5 sentences (max 20); the server tool is rate-limited to 30/min.

## Local server (M2)

The server is a thin `node:http` shell (`src/server/local-server.ts`) around pure, unit-tested MCP layers. It is **off by default**. To use it:

1. Set a strong **Server token** in settings.
2. Enable **Enable local server**.
3. Point Claude Code at `http://127.0.0.1:3999` (default port) with the token as a bearer credential.

Writes proposed over the network **always** go to the review inbox — the server never performs direct writes, even if **Allow direct memory writes** is enabled in the desktop settings. See [docs/MCP_SERVER.md](docs/MCP_SERVER.md) and [docs/CLAUDE_CODE_INTEGRATION.md](docs/CLAUDE_CODE_INTEGRATION.md).

## Embeddings & vector retrieval (M3)

Vector search is opt-in. The **Embedding provider** setting defaults to `none`, and until you change it retrieval is lexical BM25 only — no network calls, no API key. Two providers are available:

- **Ollama** (local): embeds against a local Ollama server (default endpoint `http://127.0.0.1:11434`). No API key, and note text never leaves your machine. Set the **Embedding model** to a model your Ollama has pulled.
- **OpenAI-compatible**: embeds against any OpenAI-compatible `/embeddings` endpoint (OpenAI, LM Studio, LocalAI, vLLM, …). **This sends your indexed note text to the configured endpoint**, which may be remote — an explicit, opt-in data-egress choice. It requires an endpoint, a model, and an API key (a secret, stored locally and never logged). The settings UI shows a notice when you select it.

Embedding happens at index time (reindex/refresh) and is cached in `Index/embeddings.json` inside the vault; unchanged chunks are reused so re-embedding is incremental. **Retrieval mode** (`lexical`, `hybrid`, or `vector`; default `hybrid`) controls how vectors are used. If the provider is unavailable — unset, unreachable, or erroring — search transparently degrades to lexical rather than failing. Excluded/sensitive notes are never indexed, so they are never embedded or sent anywhere. See [docs/SECURITY.md](docs/SECURITY.md) for the data-egress details.

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

## Releasing

Releases are published by the `release.yml` GitHub Actions workflow, which builds
the plugin and attaches `main.js`, `manifest.json`, and `styles.css` to a GitHub
release whenever a version tag is pushed. To cut a release:

```bash
npm version 0.2.0        # bumps package.json + syncs manifest.json / versions.json
git push --follow-tags   # pushes the commit and the tag
```

The tag must equal the `manifest.json` version (a leading `v` is tolerated), or
the workflow fails its verification step before publishing.

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
| Embedding provider | `none` | Lexical BM25 always works with `none`. `ollama` and `openai-compatible` enable vector/hybrid retrieval; `mock` is a deterministic dev provider. |
| Embedding model | *(empty)* | Model name for the selected provider (required for `ollama` and `openai-compatible`). |
| Retrieval mode | `hybrid` | `lexical`, `hybrid`, or `vector`. Forced to lexical whenever the provider is `none` or unavailable. |
| Embedding endpoint | *(empty)* | Base URL for the provider. Ollama defaults to `http://127.0.0.1:11434`; OpenAI-compatible needs the full base URL including any version prefix. |
| Embedding API key | *(empty)* | Secret bearer key for OpenAI-compatible endpoints. Stored locally, sent only in the `Authorization` header, and never logged. |
| Embedding batch size | `16` | Chunks embedded per request at index time; clamped to 1–512. |
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

The plugin registers twelve commands (command-palette names shown):

1. **Claude Code Engram: Open Control Panel**
2. **Claude Code Engram: Reindex Vault**
3. **Claude Code Engram: Search Memory**
4. **Claude Code Engram: Summarize Current Note**
5. **Claude Code Engram: Add Memory**
6. **Claude Code Engram: Add Current Note to Project Memory**
7. **Claude Code Engram: Create Project Memory Folder**
8. **Claude Code Engram: Show Project Context**
9. **Claude Code Engram: Review Pending Memory**
10. **Claude Code Engram: Start Session Note**
11. **Claude Code Engram: End Session Note**
12. **Claude Code Engram: Restart Local Server**

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

- **`summarize_note` is extractive, not abstractive.** It selects the note's own sentences; there is no LLM/generative backend, so it never rewrites or paraphrases. It also only works on notes that are in the index.
- **Desktop only.** `isDesktopOnly: true`.
- Binary attachments are not indexed.

## Roadmap

- **M1 (done):** local memory + lexical RAG.
- **M2 (done):** control-panel polish, project creation, local MCP/HTTP server with constant-time token auth and DNS-rebinding guards, curated inbox-first tools, Claude Code integration docs.
- **M3 (done):** embedding providers (Ollama, OpenAI-compatible) behind an injected HTTP boundary, vector + hybrid retrieval, and a vault-local vector cache.
- **M4 (done):** richer pending-memory review UI with per-entry apply/edit/discard, and an honest extractive `summarize_note` (Summarize Current Note command + MCP tool).
- **M5 (done):** GitHub Actions CI (typecheck/lint/test/build) and a tag-driven release workflow that publishes the plugin artifacts, plus `version-bump.mjs` tooling that keeps `manifest.json`/`versions.json` in sync.
- **Future:** non-desktop support, indexing of binary attachments, and alternative local vector stores.

Details: [docs/ROADMAP.md](docs/ROADMAP.md).

## License

MIT. See [LICENSE](LICENSE).
