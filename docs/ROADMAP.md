# Roadmap

Coder Engram is built in milestones. Milestones 1 through 12 are complete (through v0.8.0); work since the last release is listed under "In progress", and anything not scheduled is under "Deferred / future".

## Milestone 1 — local memory + lexical RAG (done)

- Plugin scaffold, settings tab, and control panel.
- Safe path validation (`resolveInVault` choke-point).
- Vault scanner with folder/tag/path-pattern filters.
- Heading- and code-fence-aware Markdown chunker with overlapping windows.
- Local JSON index with incremental mtime-based refresh and atomic persist.
- BM25 lexical retrieval with heading boost and folder/tag/project/recency filters.
- Search modal, Add Memory command, and append-only pending-memory inbox writer.
- Global / project / session memory scaffolding.
- `EmbeddingProvider` interface plus a deterministic mock (no real vector retrieval yet).
- Vitest test suite.

## Milestone 2 — server + integration (done)

- Control-panel polish and project-creation workflow refinements; live server status (`running · host:port`) and a **Restart Local Server** command.
- Local MCP/HTTP server (`src/server/`) speaking JSON-RPC 2.0 MCP (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`):
  - Disabled by default, binds to `127.0.0.1`, configurable port.
  - Constant-time bearer-token authentication (SHA-256 digest + `timingSafeEqual`), with request validation.
  - DNS-rebinding protection (Host/Origin guards), POST-only, JSON content-type required, and a 1 MB body cap.
  - New `server.allowNonLocalhost` setting (schema v2): binding a non-localhost host requires both this flag and a token.
  - Tools: `search_vault_memory`, `add_memory`, `get_project_context`, `get_global_context`, `list_projects`, `get_recent_sessions`, `reindex_vault` (rate-limited). See [MCP_SERVER.md](MCP_SERVER.md).
  - Inbox-first writes over the network by construction; the server never performs direct writes and exposes no generic file access or full-vault dump.
- Claude Code integration documentation and example MCP configuration (see [CLAUDE_CODE_INTEGRATION.md](CLAUDE_CODE_INTEGRATION.md)).

## Milestone 3 — embeddings + hybrid retrieval (done)

- Real embedding providers behind the existing `EmbeddingProvider` interface: `OllamaEmbeddingProvider` (local Ollama, no API key) and `OpenAiEmbeddingProvider` (any OpenAI-compatible `/embeddings` endpoint). A `createEmbeddingProvider` factory returns `null` (lexical fallback) when config is missing and never throws.
- New `HttpClient` boundary (`core/http-client.ts`) for all outbound client HTTP, with the production `ObsidianHttpClient` wrapping Obsidian's `requestUrl`. Providers stay Obsidian-free and unit-testable; this is the second file (with `ObsidianVaultAdapter`) permitted to import `obsidian`.
- Populated `Index/embeddings.json` via `EmbeddingStore`: incremental, content-hash-keyed vector cache written through the `VaultAdapter`.
- `VectorRetriever` (cosine) and `HybridRetriever` (Reciprocal Rank Fusion of lexical + vector) behind the existing `Retriever` interface, selected by the new `retrievalMode` setting (default `hybrid`). Settings schema bumped v2 → v3; `EngramEngine.search` became async to embed the query when needed.
- Degrades to lexical whenever the provider is `none` or unavailable — vectors are never on the critical path.

## Milestone 4 — review UI + honest summarization (done)

- Richer **Review Pending Memory** UI: each pending inbox entry is a card showing its resolved destination with per-entry **Apply**, **Edit & apply**, and **Discard** controls (`src/ui/pending-memory-modal.ts`); the raw "Open inbox file" escape hatch remains. A single pending-block parser/serializer (`src/memory/pending-inbox.ts`) is now the only producer of the on-disk inbox format, so entries round-trip (parse ⇄ render).
- **Apply promotes** a reviewed entry by appending it into the destination memory file resolved by type/project (`resolveApplyDestination`), then removes it from the inbox. New `MemoryWriter.readInbox`/`applyPending`/`discardPending` and engine `getPendingMemory`/`applyPendingMemory`/`discardPendingMemory`. Promotion is UI-only (never server-exposed), always append-only, and validated inside the memory root; it is deliberately not gated by `allowDirectWrites`. See [SECURITY.md](SECURITY.md).
- Honest **extractive** `summarize_note` (`src/summarize/extractive.ts`): it selects the note's own sentences (returned verbatim, in original order) via lexical frequency-centrality offline, or embedding-centroid similarity with MMR when an embedding provider is reachable. No LLM/generative backend was added — embeddings only improve selection and are not required. New engine `summarizeNote`/`getNoteChunks`, MCP tool `summarize_note` (default 5, max 20 sentences; rate-limited 30/min), and a **Summarize Current Note** command. It summarizes only in-index notes and fails open to lexical. See [MCP_SERVER.md](MCP_SERVER.md).

## Milestone 5 — CI + release/packaging (done)

- GitHub Actions CI workflow (`.github/workflows/ci.yml`) running typecheck, tests, lint, and the production build on push/PR.
- Release workflow (`.github/workflows/release.yml`) that builds and publishes the plugin artifacts (`main.js`, `manifest.json`, `styles.css`).
- Version-bump tooling (`version-bump.mjs`) to keep `manifest.json`, `versions.json`, and `package.json` in sync for tagged releases.

## Milestone 6 — retrieval quality (done, v0.2.0)

- Precise per-chunk line spans, surfaced in search results with open-at-line navigation.
- Densest-window snippets and word-boundary highlighting.
- Per-note result diversity (one long note can't flood a result page).
- Memoized BM25 corpus statistics (~7× faster lexical queries at scale) and an on-demand scale benchmark (`npm run bench`).
- Playwright e2e harness driving the real plugin inside real Obsidian (local-only).

## Milestone 7 — deeper, safer Claude Code memory loop (done, v0.3.0)

- `get_note_context` MCP tool: full indexed text of one note, passage by passage.
- `find_related_notes` MCP tool: link-graph neighbours of an indexed note.
- `add_memory` de-duplication so a looping agent can't flood the review inbox.
- Embeddings-cache no-op-persist guard.
- Safety-first positioning across README/manifest.

## Milestone 8 — sharper, safer, cheaper agent loop (done, v0.4.0)

- Ranged reads: `get_note_context` accepts `startLine`/`endLine` from a search hit.
- Search pages backfilled to the requested limit, dated, and line-ranged; inbox hits labelled `[PENDING REVIEW]`. Near-duplicate collapse shipped here as always-on and became an opt-in toggle in a later release.
- Output caps (`maxChars`) and rate limits on the session-priming context tools.
- O(changed) refresh file I/O (skip-unchanged scanning, config-keyed) and truly free no-op refreshes; the watcher ignores the plugin's own index writes.
- Fixed: embedding-provider settings changes now apply without a plugin reload; exclusion changes trigger their own refresh.
- Full-delta security audit before release; e2e coverage of the MCP server over the wire.

## Milestone 9 — rename + catalog readiness (done, v0.5.0)

- Renamed to **Coder Engram** (`coder-engram`); repository moved to `nfoav8or/coder-engram`. Breaking for manual installs (plugin folder id); vault data untouched, legacy inbox tags still parse.
- Community-catalog compliance: sentence-case UI text, `Modal.setTitle()` / `Setting.setHeading()`, CSS-class styling, action-statement manifest description, README network-use disclosure.
- Settings/UI correctness: text fields commit on blur (no per-keystroke server rebinds or index reloads), server auth uses a committed settings snapshot, real restart lever preserved, shared reindex guard, superseded-search rendering fix, modified dates in UI search results.
- Exclusion changes trigger their own refresh (0.4.0 audit follow-up).
- e2e coverage of the MCP server over the wire (14 checks), including the inbox → `[PENDING REVIEW]` safety loop.

## Milestone 10 — attachments become memory (done, v0.6.0)

- Opt-in attachment indexing (`indexAttachments`), dependency-free: PDF via Obsidian's bundled pdf.js, docx/pptx/xlsx and odt/odp/ods via an in-repo ZIP+XML reader, RTF, txt/csv, and Canvas. Extracted text flows through the same chunk/refresh/exclusion/retrieval path as a note, so every MCP tool reads it like one.
- Extraction cached by (path, mtime) in `Index/extracted.json`, negative results included, so a reload costs one JSON read.
- Field matching: queries now hit filenames, frontmatter aliases, and ancestor headings, and frontmatter-only hub notes became findable.
- A golden-query relevance eval harness (`npm run eval`) alongside the scale bench.
- Hardening pass over untrusted bytes: linear-time link scanning (the old regexes backtracked quadratically), per-archive aggregate inflate and part caps, and cache-version bumps that actually reach already-indexed chunks.

## Milestone 11 — bounded by the unit you pay in (done, v0.7.0, v0.7.1)

- Every agent-facing read path bounded in **characters** rather than in counts: `summarize_note` at 4 000, `find_related_notes` link lists by budget, `get_note_context` truncation that names where to resume.
- The chunker no longer emits a 100 KB chunk for a paragraph containing no blank line; such paragraphs break at whitespace, with a hard slice for a token that offers no boundary at all.
- Section budget raised 1 200 → 2 000 characters, set by measured relevance rather than by the cost curve (`INDEX_VERSION` bumped, so indexes rebuild once).
- Fixed a search that failed outright when one indexed chunk carried an unusable modified time.

## Milestone 12 — the agent's context is your choice (done, v0.8.0)

- The three output reductions that previously ran always-on — near-duplicate collapse, per-note share cap, overlapping-passage merge — became individual opt-in toggles, all off by default (settings schema v7), with a migration that preserves an earlier all-or-nothing opt-in.

## In progress (unreleased)

- Image text (OCR) as **plugin interop**: `indexImageText` delegates to the Text Extractor plugin's API rather than bundling an engine (see docs/SECURITY.md for why), at a cost of ~1.2 KB of bundle.
- Attachment robustness at scale: a per-file text ceiling, a corpus-wide budget that keeps a large vault's index serializable, no file read for extractors that work from the path alone, and attachment metadata cached rather than re-derived on every refresh.

## Deferred / future

- Non-desktop support (currently `isDesktopOnly`).
- Scanned-PDF OCR. The same delegation would need Text Extractor's PDF path, which its own README flags as unreliable.
- Cost control for a first refresh over thousands of images: OCR is serial and expensive per cache miss, and capping the work per scan would mean partial-index semantics.
- Alternative local vector stores (SQLite, LanceDB, DuckDB) behind the storage model.
