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
| `npm run lint` | ESLint over `.ts` sources. |
| `npm run typecheck` | `tsc --noEmit --skipLibCheck`. |

Before committing, run `npm run typecheck`, `npm run test`, and `npm run build`.

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
  core/
    vault-adapter.ts            VaultAdapter interface + in-memory impl
    obsidian-vault-adapter.ts   production adapter
    markdown-chunker.ts         chunking
    metadata-extractor.ts       frontmatter / tags / links
  retrieval/
    retriever.ts                Retriever interface + types
    lexical-retriever.ts        BM25 retriever
    ranking.ts                  tokenize / filter / snippet helpers
  embeddings/
    embedding-provider.ts       EmbeddingProvider interface + cosine
    mock-embedding-provider.ts  deterministic mock
  memory/
    memory-types.ts             data model + folder layout
    memory-store.ts             read-side context + scaffold
    memory-writer.ts            inbox + direct writes
    project-memory.ts           project + session scaffolding
  utils/
    paths.ts                    path safety (resolveInVault)
    logger.ts                   debug-gated logger + redaction
    errors.ts                   typed errors
    validation.ts               small validators
    debounce.ts                 debounce helper
tests/                          Vitest suite (mirrors src)
```

The `server/` directory from the spec is not present yet; it arrives in Milestone 2.

## Testing in a real vault

1. Point a `dev` build at a scratch vault (copy/symlink the outputs as above).
2. Run **Reindex Vault**, then **Search Memory** to confirm retrieval.
3. Run **Add Memory** and check that a block lands in `Claude Code/Memory/Inbox/pending-memory.md`.
4. Run **Create Project Memory Folder** and confirm the project scaffold appears under `Claude Code/Memory/Projects/`.

The unit tests use `InMemoryVaultAdapter`, so most logic can be exercised without Obsidian: `npm run test`.

## Coding conventions

- **The service and core layers must not import `obsidian`.** Only the UI layer (`main.ts`, `settings/settings-tab.ts`, `ui/*`) and `core/obsidian-vault-adapter.ts` may. This keeps indexing/retrieval/memory unit-testable and lets the future server reuse `EngramEngine`.
- **All vault paths go through `utils/paths`.** Never build a vault path by ad-hoc string concatenation. Use `resolveInVault` / `joinVaultPath` / `normalizeVaultRelativePath`. `MemoryWriter` is the only component that writes memory.
- **Keep modules small and functions testable.** Prefer pure functions in the core layer; inject the `VaultAdapter`, `Logger`, and clock.
- **Safe defaults.** New settings must default to the privacy-preserving, local-only choice, and `migrateSettings` must degrade a corrupt settings blob to defaults without throwing.
- **No secrets in logs.** Log through the provided `Logger`; it redacts secret-looking keys.
