# Roadmap

Coder Engram is built in milestones. Milestones 1 through 14 are complete (through 0.10.0); the patch releases between 0.9.0 and 0.9.9 are listed under "Patch releases since v0.9.0", the Obsidian review findings and what was done about each under "Plugin review findings", work not yet released under "In progress", and anything not scheduled under "Deferred / future".

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
- e2e coverage of the MCP server over the wire, including the inbox → `[PENDING REVIEW]` safety loop. (The suite has grown since; `npm run test:e2e` prints the current count.)

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

## Milestone 13 — untrusted files, safely (done, v0.9.0)

- Image text (OCR) as **plugin interop**: `indexImageText` delegates to the Text Extractor plugin's API rather than bundling an engine (see docs/SECURITY.md for why), at a cost of ~1.2 KB of bundle.
- Attachment robustness at scale: a per-file text ceiling, a corpus-wide budget that keeps a large vault's index serializable, no file read for extractors that work from the path alone, and attachment metadata cached rather than re-derived on every refresh.
- Bounds in TIME as well as size — PDF parsing, image OCR, and outbound HTTP each race a timer, because work that hangs throws nothing for a `catch` and would leave a refresh waiting forever.
- Four security fixes to existing paths: plaintext secrets in the settings backup, inbox format forgery through `add_memory`, list fields that walked around its size caps, and a failed write that destroyed both the old and the new copy of a file.
- `minAppVersion` raised to 1.7.2, matching the `workspace.revealLeaf` the control panel actually calls.
- Supply chain and packaging: signed build provenance on release assets, a `versions.json` release gate, checksum verification that works on macOS and refuses an asset it cannot account for, and one fewer dependency.
- Test discipline: type-aware linting, an architecture test that enforces the layering rules, first coverage for the installer, and e2e checks for the two adapters no unit test can reach.

## Milestone 14 — declarative settings (done, 0.10.0)

- **The settings tab is declarative** (`getSettingDefinitions()`), so every setting appears in Obsidian's settings search on 1.13 and later. A tab driven only by `display()` is absent from that search, which for a plugin with thirty settings is a real discoverability loss.
- **The tab became data.** `settings/setting-definitions.ts` describes every setting — control, validation, provider-dependent visibility — and imports `obsidian` for types only, so it is erased at build time and unit-testable. `settings/settings-tab.ts` is the thin shell that supplies value reads/writes and what happens after a change. Roughly 500 lines of untestable UI became a value the suite asserts over: that every persisted setting is bound to a control, that no two controls share a key, that every key round-trips through the settings object, and that the API-key row is hidden for every provider except the one that needs it.
- **`minAppVersion` stays 1.7.2** and `display()` stays with it. Obsidian ignores `display()` as soon as `getSettingDefinitions()` returns anything, so 1.13+ renders declaratively while older apps keep the imperative tab. Raising the floor instead would have stranded every user below 1.13 on 0.9.9.
- Better than the imperative version in two places: the memory root is now rejected inline as you type (it was a `Notice` after the fact), and image-text indexing is visibly disabled until attachment indexing is on.
- The layering test now distinguishes a **type-only** import of `obsidian` from a value import. The invariant it protects is "no runtime dependency on the host outside the adapters", and `import type` is erased — which is what makes the definitions testable.

## Plugin review findings (Obsidian automated review of 0.9.9)

Recorded in full, including the ones deliberately left alone. Reproduced locally with
`eslint-plugin-obsidianmd`, run from the repo root so it can read `manifest.json`.

| Finding | Severity | Resolution |
| --- | --- | --- |
| `Plugin.settings` requires 1.13.0 but minAppVersion is 1.7.2 (`settings-tab.ts`) | Error | **Fixed in 0.10.0.** Obsidian 1.13 added its own `Plugin.settings`, and the tab held its host as `Plugin & SettingsHost`, so the read resolved to Obsidian's property. The host is now held at its `SettingsHost` type. |
| Avoid casting to `TFile` (`obsidian-ocr-extractor.ts`) | Warning | **Fixed in 0.10.0.** Replaced with a type predicate. Structural narrowing stays: `obsidian` ships types only, so naming `TFile` in a value position would break the Node test environment. |
| Unnecessary type assertion (`settings.ts`) | Warning | **Fixed in 0.10.0.** |
| PluginSettingTab does not implement `getSettingDefinitions()` | Warning | **Fixed in 0.10.0** — this milestone. |
| `display` is deprecated since 1.13.0 | Recommendation | **Kept deliberately.** It is the pre-1.13 fallback and is never called on 1.13+. Removing it would mean raising `minAppVersion` to 1.13.0 and stranding older users. |
| Use `window.setTimeout()` / `window.clearTimeout()` (7 sites) | Warning | **Not applicable.** All seven are in the pure core and the server layer, which also run in the Node test environment (no `window`) and, for the server, under Node itself. No UI file uses a timer. The rule targets popout-window lifetimes, which these timers do not participate in. |
| Avoid using `global` (`memory-types.ts:63`) | Warning | **False positive.** That line is `global: string;`, a property of the `MemoryPaths` interface, not Node's `global`. |
| Avoid unnecessary logging to console (`logger.ts`) | Warning | **Kept deliberately.** The logger is gated by the `debugLogging` setting; warnings and errors always emit because they are actionable, and every context object is redacted first. |
| Release contains extra unsupported files (`SHA256SUMS`) | Recommendation | **Kept deliberately.** `scripts/install.sh` verifies downloads against it, and Obsidian simply does not download it. |
| Vault enumeration (`getMarkdownFiles`) | Recommendation | **Inherent.** The plugin is a vault indexer; enumerating notes is the feature. Exclusions are applied before anything is read. |
| Unsafe `any` in the ZIP inflate loop (`zip.ts`) | Error (their config) | **Fixed in 0.10.0.** `pipeThrough` loses the element type, so the inflated chunks were `any` — and the size accounting there is what stands between a crafted archive and an unbounded allocation. The reader is now annotated. |
| Build reproduced the release `main.js` byte-for-byte; attestations verified | Pass | No action. |

## Patch releases since v0.9.0

No new surface — nine releases of fixes found by auditing what was already shipped. Each is
described in full in [CHANGELOG.md](../CHANGELOG.md); the short version:

| Version | Fix |
| --- | --- |
| 0.9.1 | RTF extraction stopped walking a document one character at a time (19 MB: 1.2 s and 212 MB of heap → 91 ms and 23 MB, byte-identical output). |
| 0.9.2 | An excluded folder typed in a different case silently indexed the notes it named. |
| 0.9.3 | `list_projects` was the only tool with no rate limit. |
| 0.9.4 | One empty note made every startup rewrite the whole index. |
| 0.9.5 | Startup stopped re-reading every note in the vault (the index now records which scan config its mtimes were gathered under). |
| 0.9.6 | That optimization was reaching only new users; an index from an older version never acquired the record. |
| 0.9.7 | Toggling **Index text inside images** did nothing until an unrelated edit — including turning it *off*, which left extracted text searchable. |
| 0.9.8 | `list_projects` was the only read tool with no output cap (1 000 projects returned 197 KB). |
| 0.9.9 | An exclusion naming an accented folder, tag, or pattern silently matched nothing across macOS's decomposed filenames. |

Three themes run through them, and they are worth stating because they are where the next
bug probably is: a filter that fails **open** is invisible (0.9.2, 0.9.7, 0.9.9); a tool that
looks cheap gets bounded last (0.9.3, 0.9.8); and an optimization is not delivered until it
is verified on the state an *upgrading* user actually has on disk (0.9.6).

## In progress (unreleased)

- Nothing yet — 0.10.0 has just been cut.

## Deferred / future

- **MCP revision 2026-07-28.** This server implements 2025-06-18 and negotiates it honestly (see docs/MCP_SERVER.md); the current revision has since moved twice (2025-11-25, then 2026-07-28). The newer revision is a base-protocol rewrite, not a tools change: it removes the `initialize`/`notifications/initialized` handshake and `ping` in favour of a stateless model where each request carries `io.modelcontextprotocol/protocolVersion` in `_meta`, requires a new `server/discover` RPC, and answers a version mismatch with `UnsupportedProtocolVersionError`. The tool surface is untouched — `tools/list` and `tools/call` still use `inputSchema`, `content`, `isError`, and `nextCursor` — so the work is confined to the protocol layer. **Not urgent:** the spec explicitly permits a server to implement both eras ("A server that wishes to support both legacy clients … and modern clients … MAY implement both behaviors"), and its own compatibility matrix has legacy-client/legacy-server working, which is what Claude Code does today.
- Non-desktop support (currently `isDesktopOnly`).
- Scanned-PDF OCR. The same delegation would need Text Extractor's PDF path, which its own README flags as unreliable.
- Cost control for a first refresh over thousands of images: OCR is serial and expensive per cache miss, and capping the work per scan would mean partial-index semantics.
- Alternative local vector stores (SQLite, LanceDB, DuckDB) behind the storage model.
