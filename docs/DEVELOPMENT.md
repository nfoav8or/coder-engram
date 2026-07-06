# Development

## Prerequisites

- Node.js 20+ (matches `@types/node`).
- An Obsidian desktop install (1.5.0+) with a test vault.

## Setup

```bash
npm install
npm run dev      # esbuild watch build → main.js
```

`npm run dev` rebuilds `main.js` on change. To load it in Obsidian, make the build outputs visible under your test vault:

```
<vault>/.obsidian/plugins/claude-code-engram/
  main.js
  manifest.json
  styles.css
```

Copy or symlink `main.js`, `manifest.json`, and `styles.css` there, then enable **Claude Code Engram** under Settings → Community plugins. After a rebuild, use **Reload plugins** (or the "Hot Reload" community plugin) to pick up changes.

## npm scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | esbuild watch build (development). |
| `npm run build` | `tsc --noEmit` typecheck, then a production esbuild bundle. |
| `npm run test` | Run the Vitest suite once. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:e2e` | Local-only UI smoke test in real Obsidian (see below). |
| `npm run bench` | Local-only retrieval scale benchmark (`tests/scale.bench.ts`; excluded from `npm test`/CI). Prints build/refresh/query numbers over a large synthetic vault. Override size with `BENCH_NOTES=5000`. |
| `npm run lint` | ESLint over `.ts` sources. |
| `npm run typecheck` | `tsc --noEmit --skipLibCheck`. |

Before committing, run `npm run typecheck`, `npm run test`, and `npm run build`.

## End-to-end UI test (`npm run test:e2e`)

`tests/e2e/run.mjs` drives the **real plugin inside a real Obsidian** with
Playwright, asserting on rendered DOM (e.g. that search snippets highlight
whole-word matches). It complements the Vitest suite, which covers the pure core
but never renders the Obsidian UI.

It is **local-only and deliberately excluded from `npm test` and CI**: it needs
Obsidian installed and a display, which CI runners don't have. Run it after a
build:

```bash
npm run build && npm run test:e2e
```

- It self-provisions a throwaway vault + isolated `--user-data-dir` in a temp
  folder (never touching your real Obsidian config), installs the built plugin,
  enables it past Restricted Mode via the API, and cleans up afterward.
- Obsidian is located via `$OBSIDIAN_BIN`, then common paths, then `$PATH`. If
  Obsidian or a display is missing, the script **skips** (exit 0), so it is safe
  to run anywhere.
- Mechanism: Obsidian is a packaged Electron app that ignores Playwright's
  auto-launch attach, so the harness launches it with `--remote-debugging-port`
  and connects via `chromium.connectOverCDP` (`playwright-core`, no browser
  download).

## Project layout

```
src/
  main.ts                       plugin entrypoint (Obsidian glue)
  engine.ts                     EngramEngine orchestration facade
  settings/
    settings.ts                 settings model, defaults, migration
    settings-tab.ts             settings UI
  ui/
    control-panel-view.ts       right-sidebar view
    search-modal.ts             search UI
    add-memory-modal.ts         add-memory UI
    pending-memory-modal.ts     inbox review UI
    simple-modals.ts            prompt / text-display helpers
    format.ts                   pure display helpers (line ranges)
  indexing/
    vault-scanner.ts            note enumeration + filters
    index-manager.ts            build / refresh / persist / load
    link-graph.ts               wikilink graph (find_related_notes)
  core/
    vault-adapter.ts            VaultAdapter interface + in-memory impl
    obsidian-vault-adapter.ts   production adapter
    http-client.ts              HttpClient boundary for outbound HTTP
    obsidian-http-client.ts     production adapter over requestUrl
    markdown-chunker.ts         chunking
    metadata-extractor.ts       frontmatter / tags / links
  retrieval/
    retriever.ts                Retriever interface + types
    lexical-retriever.ts        BM25 retriever
    vector-retriever.ts         cosine vector retriever
    hybrid-retriever.ts         RRF fusion of lexical + vector
    ranking.ts                  tokenize / filter / snippet helpers
  embeddings/
    embedding-provider.ts       EmbeddingProvider interface + cosine
    mock-embedding-provider.ts  deterministic mock
    ollama-provider.ts          local Ollama provider
    openai-embedding-provider.ts  OpenAI-compatible provider
    embedding-http.ts           shared embedding HTTP helpers
    embedding-store.ts          content-hash-keyed vector cache
    provider-factory.ts         createEmbeddingProvider factory
  memory/
    memory-types.ts             data model + folder layout
    memory-store.ts             read-side context + scaffold
    memory-writer.ts            inbox + direct writes
    pending-inbox.ts            pending-block parser / serializer
    project-memory.ts           project + session scaffolding
  server/
    local-server.ts             local HTTP server + lifecycle
    mcp-protocol.ts             JSON-RPC 2.0 MCP protocol
    mcp-tools.ts                MCP tool definitions + handlers
    auth.ts                     constant-time bearer-token auth
    net.ts                      Host/Origin guards + request checks
  summarize/
    extractive.ts               extractive note summarizer
  utils/
    paths.ts                    path safety (resolveInVault)
    logger.ts                   debug-gated logger + redaction
    errors.ts                   typed errors
    validation.ts               small validators
    debounce.ts                 debounce helper
tests/                          Vitest suite (mirrors src)
```

The `src/server/` directory is present: it implements the local MCP/HTTP server (added in Milestone 2).

## Testing in a real vault

1. Point a `dev` build at a scratch vault (copy/symlink the outputs as above).
2. Run **Reindex Vault**, then **Search Memory** to confirm retrieval.
3. Run **Add Memory** and check that a block lands in `Claude Code/Memory/Inbox/pending-memory.md`.
4. Run **Create Project Memory Folder** and confirm the project scaffold appears under `Claude Code/Memory/Projects/`.

The unit tests use `InMemoryVaultAdapter`, so most logic can be exercised without Obsidian: `npm run test`.

## Coding conventions

- **The service and core layers must not import `obsidian`.** Only the UI layer (`main.ts`, `settings/settings-tab.ts`, `ui/*`), `core/obsidian-vault-adapter.ts`, and `core/obsidian-http-client.ts` may. This keeps indexing/retrieval/memory unit-testable and lets the server reuse `EngramEngine`.
- **All vault paths go through `utils/paths`.** Never build a vault path by ad-hoc string concatenation. Use `resolveInVault` / `joinVaultPath` / `normalizeVaultRelativePath`. `MemoryWriter` is the only component that writes memory.
- **Keep modules small and functions testable.** Prefer pure functions in the core layer; inject the `VaultAdapter`, `Logger`, and clock.
- **Safe defaults.** New settings must default to the privacy-preserving, local-only choice, and `migrateSettings` must degrade a corrupt settings blob to defaults without throwing.
- **No secrets in logs.** Log through the provided `Logger`; it redacts secret-looking keys.
