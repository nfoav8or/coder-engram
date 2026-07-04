# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Claude Code Engram is an Obsidian **desktop plugin** that turns the active vault into a local-first
memory + RAG backend for Claude Code. All plugin-managed data lives as Markdown under a
`Claude Code/` root **inside** the vault. The bundled artifact is `main.js` (esbuild CJS bundle of
`src/main.ts`).

## Commands

```bash
npm run dev         # esbuild watch build (writes main.js; symlink/copy into a test vault's plugin dir)
npm run build       # tsc --noEmit typecheck THEN production esbuild bundle
npm run typecheck   # tsc --noEmit --skipLibCheck
npm run lint        # eslint over .ts
npm test            # vitest run (whole suite, node env)
npm run test:watch  # vitest watch

# Run a single test file or by name:
npx vitest run tests/markdown-chunker.test.ts
npx vitest run -t "assigns each window its own precise line span"
```

Tests live in `tests/` (mirroring `src/`), run in the `node` environment, and exercise the pure core
via `InMemoryVaultAdapter` / `FakeHttpClient` — no real Obsidian or network needed.

## Architecture: thin shell + pure core

The single most important rule: **the service/core layers must never import `obsidian` or `node:*`.**
Only these files touch the host, and each is a thin adapter over a pure interface:

- `src/core/obsidian-vault-adapter.ts` — the only production file that reads/writes the vault (implements `VaultAdapter`).
- `src/core/obsidian-http-client.ts` — the only production file that makes outbound HTTP (implements `HttpClient`, wraps Obsidian's `requestUrl`; `requestUrl` can't be aborted, so it races against a rejecting timer for timeouts).
- `src/server/local-server.ts` — the only file that imports `node:http`.
- The UI layer (`src/main.ts`, `src/settings/settings-tab.ts`, `src/ui/*`).

Everything else is pure and unit-tested. This keeps indexing/retrieval/memory logic testable and lets
the UI and the MCP server share one code path.

`src/engine.ts` (`EngramEngine`) is the Obsidian-agnostic **facade** over indexing, retrieval, and
memory. Both the UI (`main.ts`) and the MCP server (`server/mcp-tools.ts`) drive the engine — never
duplicate engine logic in either caller. `EngramEngine.search` is **async** (vector/hybrid modes embed
the query first; lexical resolves with no network).

**All vault paths route through `src/utils/paths.ts` (`resolveInVault` / `joinVaultPath` /
`normalizeVaultRelativePath`).** It normalizes vault-relative paths and rejects absolute paths and `..`
traversal. Never build a vault path by string concatenation. `MemoryWriter` is the only component that
writes memory files.

### Retrieval

`src/retrieval/retriever.ts` defines the `Retriever` interface with three implementations selected by
the `retrievalMode` setting: `lexical-retriever.ts` (BM25 + heading boost), `vector-retriever.ts`
(cosine), `hybrid-retriever.ts` (Reciprocal Rank Fusion of the two, default). `ranking.ts` holds shared
tokenize/filter/snippet helpers. Embedding providers (`src/embeddings/`) sit behind
`EmbeddingProvider`; `provider-factory.ts` returns `null` (→ lexical) whenever config is missing and
never throws. Vectors are cached in `Index/embeddings.json` by `embedding-store.ts` with an
identity-aware cache (provider+model+hash(endpoint)+hash(apiKey)); a backend/identity mismatch degrades
to lexical rather than scoring against stale vectors.

### Memory model

Markdown under `Claude Code/` is the durable source of truth; the JSON under `Index/`
(`chunks.json`, `metadata.json`, `embeddings.json`) is a rebuildable cache. `src/core/markdown-chunker.ts`
is heading-aware and fenced-code-aware, and windows long sections into overlapping chunks; each chunk
carries a precise original-line span. `src/memory/pending-inbox.ts` is the **single producer** of the
on-disk pending-memory block format — `MemoryWriter.formatMemoryEntry` delegates to its
`renderPendingBlock`, so the inbox round-trips (parse ⇄ render). Inbox read-modify-write is serialized
through `MemoryWriter`'s `enqueueInbox` mutex.

## Security invariants (do not weaken)

These are load-bearing and enforced across the layers above:

- **Nothing is written outside the vault.** Every path goes through the `resolveInVault` choke-point.
- **Writes default to the append-only review inbox** (`pending-memory.md`). Direct memory writes are
  double-gated (`allowDirectWrites` setting **and** in-root check) and off by default.
- **The local MCP/HTTP server is disabled by default**, binds `127.0.0.1`, uses constant-time
  bearer-token auth, and applies DNS-rebinding (Host/Origin) guards. Binding a non-localhost host
  requires **both** `allowNonLocalhost` **and** a token. Server writes are **always** inbox-first — the
  server never performs a direct write even when `allowDirectWrites` is on — and it exposes no generic
  file access or full-vault dump.
- **Apply/promotion of an inbox entry is UI-only** (never in `ALL_TOOLS`), always an append (never
  overwrites), and in-root-validated. It is intentionally *not* gated by `allowDirectWrites` (that
  governs unattended writes; promotion is human-in-the-loop).
- **Embeddings are opt-in** (`embeddingProvider` defaults to `none`). The OpenAI-compatible provider
  sends note text off-machine, so it is explicit opt-in; the API key is sent only in the `Authorization`
  header and never logged; excluded/sensitive notes are never indexed, so never embedded/sent.
- `summarize_note` reads only **indexed** chunks (excluded notes have none → refused), so it can't
  become an exfiltration side channel; it fails open to lexical.
- `migrateSettings` must degrade a corrupt settings blob to safe defaults without throwing; new settings
  default to the privacy-preserving, local-only choice.

## Build & release

`main.js` is **git-ignored** — it is not committed; the release workflow builds it fresh. Work lands on
`develop`; `main` is fast-forwarded at release time. Pushing a version tag (`0.1.0` or `v0.1.0`)
triggers `.github/workflows/release.yml`, which gates on a green typecheck/lint/test/build, verifies the
tag equals `manifest.json`'s version (a leading `v` is tolerated), and publishes `main.js`,
`manifest.json`, `styles.css` to a GitHub Release. `npm version <x.y.z>` runs `version-bump.mjs` to keep
`manifest.json` + `versions.json` in sync with `package.json`.

## Deeper design docs

`docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/RAG_PIPELINE.md`, `docs/MCP_SERVER.md`,
`docs/MEMORY_MODEL.md`, and `docs/CLAUDE_CODE_ENGRAM_PROJECT_SPEC.md` (the original spec, including the
per-milestone review process). Keep these in sync when you change the corresponding subsystem.
