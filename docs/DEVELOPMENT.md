# Development

## Prerequisites

- Node.js 20+ (matches `@types/node`).
- An Obsidian desktop install (1.7.2+) with a test vault.

## Setup

```bash
npm install
npm run dev      # esbuild watch build → main.js
```

`npm run dev` rebuilds `main.js` on change. To load it in Obsidian, make the build outputs visible under your test vault:

```
<vault>/.obsidian/plugins/coder-engram/
  main.js
  manifest.json
  styles.css
```

Copy or symlink `main.js`, `manifest.json`, and `styles.css` there, then enable **Coder Engram** under Settings → Community plugins. After a rebuild, use **Reload plugins** (or the "Hot Reload" community plugin) to pick up changes.

## npm scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | esbuild watch build (development). |
| `npm run build` | `tsc --noEmit` typecheck, then a production esbuild bundle. |
| `npm run test` | Run the Vitest suite once. Includes `tests/install-script.test.ts`, which drives `scripts/install.sh` against a `file://` stand-in for a GitHub release (via its `CODER_ENGRAM_BASE_URL` override) and skips where `curl` or a sha256 tool is unavailable. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:e2e` | Local-only UI smoke test in real Obsidian (see below). |
| `npm run bench` | Local-only retrieval scale benchmark (`tests/scale.bench.ts`; excluded from `npm test`/CI). Prints build/refresh/query numbers over a large synthetic vault. Override size with `BENCH_NOTES=5000`. Also reports a warm attachment refresh (`BENCH_ATTACHMENTS=300`), the path an idle vault pays on every auto-index. |
| `npm run eval` | Local-only relevance eval (`tests/relevance.bench.ts`; excluded from `npm test`/CI). Golden-query recall@8 + MRR per query class over planted needle notes — run before/after any ranking change. |
| `npm run lint` | ESLint over `.ts` sources, **type-aware** (`recommended-requiring-type-checking`, via `tsconfig.eslint.json`). This is what catches unchecked `any` and floating promises locally — the class of finding the Obsidian plugin review scan reports, which an untyped config cannot see. |
| `npm run typecheck` | `tsc --noEmit --skipLibCheck`. |

Before committing, run `npm run typecheck`, `npm run test`, and `npm run build`.

## Checking that a test actually holds something

A green suite says the tests pass, not that they would fail if the code broke.
When you add a test for an invariant — especially a security one — break the
line that enforces it and confirm that test goes red. Turning a guard into
`if (false)` for one run is usually enough.

Sweeping this way over the load-bearing guards has repeatedly found tests that
passed for the wrong reason: an error-class assertion satisfied by a different
guard throwing the same class, a write test that used a path where append and
overwrite look identical, a cap whose effect the assertions never observed.

Two caveats worth knowing before treating a surviving mutation as a gap:

- **Equivalent mutations exist.** Some edits change the code without changing
  observable behavior — an early `return` whose fall-through computes the same
  result. Confirm the mutation really breaks something before writing a test
  for it.
- **Some invariants aren't observable this way.** `timingSafeStrEqual` can be
  made non-constant-time without any assertion noticing, because timing is not
  what the suite measures. Say so rather than writing a test that pretends.

`tests/e2e/run.mjs` drives the **real plugin inside a real Obsidian** with
Playwright, asserting on rendered DOM (e.g. that search snippets highlight
whole-word matches). It also drives the MCP server over real HTTP — auth,
protocol-version negotiation, search, the inbox → `[PENDING REVIEW]` loop, and
PDF/docx attachment extraction through Obsidian's own engines. It complements
the Vitest suite, which covers the pure core but never renders the Obsidian UI
and never starts a real listener.

It is also the **only** place `ObsidianVaultAdapter` and `ObsidianHttpClient`
run at all: the `obsidian` package ships types with no runtime, so neither can
be unit tested — the Vitest suite drives the pure interfaces through
`InMemoryVaultAdapter` and `FakeHttpClient`, which means `requestUrl` and the
temp-sibling write dance never execute there. The run therefore checks the
things only a real adapter can get wrong: that a second inbox proposal appends
rather than replacing the first, that an edit to an indexed note is picked up
by an *incremental* refresh (which depends on real mtimes being reported), that
the vault holds no `.engram-tmp-*` or `.engram-bak-*` leftovers, and that an
embedding request reaches a stub endpoint on loopback with the API key in the
`Authorization` header and nowhere else.

When adding a check here, verify it by breaking the line it holds and
rebuilding — `main.js` is what Obsidian loads, so a source edit alone changes
nothing. For the same reason, always rebuild after such an experiment: a stale
bundle silently keeps the mutation.

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
  indexing/
    vault-scanner.ts            note enumeration + filters
    index-manager.ts            build / refresh / persist / load
    link-graph.ts               wikilink graph (find_related_notes)
  extract/
    text-extractor.ts           attachment-to-text boundary + PDF rendering
    extraction-cache.ts         mtime-keyed extracted-text cache
    canvas-extractor.ts         Canvas text-card extraction (pure JSON)
    office-extractor.ts         Office/OpenDocument extraction (ZIP+XML)
    rtf-extractor.ts            RTF single-pass parser
    plain-text-extractor.ts     txt/csv passthrough
    zip.ts                      minimal ZIP reader (DecompressionStream)
  core/
    vault-adapter.ts            VaultAdapter interface + in-memory impl
    obsidian-vault-adapter.ts   production adapter
    obsidian-pdf-extractor.ts   PDF extraction via Obsidian's loadPdfJs()
    obsidian-ocr-extractor.ts   image text via the Text Extractor plugin
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
    errors.ts                   typed errors + toMessage
    format.ts                   pure display helpers (line range, mtime day)
    validation.ts               small validators
    debounce.ts                 debounce helper
    timeout.ts                  withTimeout — bounds a WAIT on work that may never settle
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

- **The service and core layers must not import `obsidian`.** Only the UI layer (`main.ts`, `settings/settings-tab.ts`, `ui/*`), `core/obsidian-vault-adapter.ts`, `core/obsidian-http-client.ts`, and `core/obsidian-pdf-extractor.ts` may. This keeps indexing/retrieval/memory unit-testable and lets the server reuse `EngramEngine`.
- **All vault paths go through `utils/paths`.** Never build a vault path by ad-hoc string concatenation. Use `resolveInVault` / `joinVaultPath` / `normalizeVaultRelativePath`. `MemoryWriter` is the only component that writes memory.
- **Keep modules small and functions testable.** Prefer pure functions in the core layer; inject the `VaultAdapter`, `Logger`, and clock.
- **Safe defaults.** New settings must default to the privacy-preserving, local-only choice, and `migrateSettings` must degrade a corrupt settings blob to defaults without throwing.
- **No secrets in logs.** Log through the provided `Logger`; it redacts secret-looking keys.
