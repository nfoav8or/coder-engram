# Roadmap

Coder Engram is built in milestones. Milestones 1 through 15 are complete (through 0.11.0); the releases from 0.9.1 to 0.13.0 are listed under "Patch releases since 0.9.0", the Obsidian review findings and what was done about each under "Plugin review findings", work not yet released under "In progress", and anything not scheduled under "Deferred / future".

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
- **`minAppVersion` stayed 1.7.2 through 0.11.4, and `display()` stayed with it.** Obsidian ignores `display()` as soon as `getSettingDefinitions()` returns anything, so 1.13+ rendered declaratively while older apps kept the imperative tab. **0.12.0 raised the floor to 1.13.0 and deleted `display()`** — see the 0.12.0 row. What made that acceptable is the same mechanism that made the dual path work: `versions.json` maps every release up to 0.11.4 to 1.7.2, so an app below 1.13 is offered 0.11.4 and keeps a working plugin rather than being stranded or handed a tab it cannot render.
- Better than the imperative version in two places: the memory root is now rejected inline as you type (it was a `Notice` after the fact), and image-text indexing is visibly disabled until attachment indexing is on.
- The layering test now distinguishes a **type-only** import of `obsidian` from a value import. The invariant it protects is "no runtime dependency on the host outside the adapters", and `import type` is erased — which is what makes the definitions testable.

## Milestone 15 — large vaults, part 1: size-adaptive persistence (done, 0.11.0)

- **Both caches shard past ~20k entries.** `chunks.json` becomes 256 shard files routed by FNV-1a of the note path; `embeddings.json` becomes a vector-less manifest plus 256 vector shards routed by chunk id. An edit rewrites ~1/256 of the corpus, and an embedding checkpoint rewrites only the shards it touched. Below the threshold (with hysteresis at 80%) nothing changes: small vaults keep byte-identical single files. The layout is recorded in the metadata, never re-derived; the rules live once in `utils/sharding.ts`.
- **Builds no longer freeze the UI.** `IndexManager.build`/`refresh` yield to the host every 500 re-chunked notes, and the engine serializes overlapping index passes on one chain — the yields made the auto-index debounce, a settings-triggered refresh, and the `reindex_vault` tool interleavable.
- **Review loop on the above** found and fixed: a missing chunk shard loaded as "no notes here" and, because the note's mtime read as unchanged, stayed missing forever; a layout switch blanked the old file before writing the metadata, so a crash in the window produced a valid empty index; one failed embedding checkpoint rejected every later persist without running it; a shape-valid base64 vector could throw `RangeError` out of retriever construction at startup.
- **Local server hardening** from the same pass: 10 failed authentications in 60 s lock the server (`429`) until the window drains, explicit socket timeouts replace Node's minutes-long defaults, and a non-localhost bind requires a 16+ character token.
- **Assessment for the rest of the track** is in [LARGE_VAULTS.md](LARGE_VAULTS.md): lazy chunk text (P2.2), worker offload (P2.3 remainder), and a measured pure-TS IVF approximate-nearest-neighbour prototype (P3.1; 43–57× query speedup at ≥99.7% recall in the spike).

## Plugin review findings (Obsidian automated review)

Recorded in full, including the ones deliberately left alone. Reproduced locally with
`eslint-plugin-obsidianmd`, run from the repo root so it can read `manifest.json`.

**The 0.10.0 review carried no errors, and 0.10.1 clears the last false positive.** Everything in the Error and Warning columns of the
0.9.9 review is resolved except the entries marked "kept" or "not applicable" below,
which are deliberate and expected to recur (two of them were later fixed outright — see
the 0.11.3 review note). Build verification passed again: the release
`main.js` was reproduced byte-for-byte from the repository, and both it and `styles.css`
have verified attestations.

**The 0.11.0 review (Aug 24 2026, commit `7fd2a53`) surfaced two new source findings, both
introduced by the sharded-persistence work and both fixed on the 0.11.x track** — see the
rows below. Everything else it reported is one of the standing "kept"/"not applicable"
entries. Build verification and both attestations passed again.

**The 0.11.3 review (Aug 28 2026, commit `4375cd0`) carried no errors.** Its one new
finding — a second "expected an error object to be thrown" — was real and is fixed; see
its row. Everything else it reported is one of the standing entries below, each of which
was re-examined at that review rather than waved through:

- The standing "kept"/"inherent" entries were re-confirmed deliberately, with the trade-off
  each one buys written out in its row. They are expected to recur in every future review,
  and the rows exist so a reviewer can see the decision instead of re-deriving it.
- **Two of them stopped being standing entries after this review.** The maintainer
  re-opened the set and chose to fix the timer sites rather than keep explaining them, and
  to close the whole `no-throw-literal` class rather than the one site reported. Three
  remain deliberate: `SHA256SUMS` (scripted installs verify against it and fail closed
  without it), the unconditional `warn`/`error` console output (the only channel for
  degradations, and gating it would restore the silent-failure class this cycle spent
  releases removing), and vault enumeration (the plugin is a vault indexer).
- Build verification reproduced the release `main.js` byte-for-byte again, and both it and
  `styles.css` carry verified attestations.
- **Line numbers in the table are as the review reported them, at the commit named in that
  row's severity column** — they are a record of a report, not a claim about `HEAD`, and
  ordinary edits move them. The logger row — the one standing source finding a maintainer
  still re-opens each cycle — also carries its current-tree line, kept in step by hand.
  Without this convention the citations rot silently and the row stops doing the one job
  it exists for: letting a reviewer check the decision instead of re-deriving it.

| Finding | Severity | Resolution |
| --- | --- | --- |
| `Plugin.settings` requires 1.13.0 but minAppVersion is 1.7.2 (`settings-tab.ts`) | Error | **Fixed in 0.10.0.** Obsidian 1.13 added its own `Plugin.settings`, and the tab held its host as `Plugin & SettingsHost`, so the read resolved to Obsidian's property. The host is now held at its `SettingsHost` type. |
| Avoid casting to `TFile` (`obsidian-ocr-extractor.ts`) | Warning | **Fixed in 0.10.0.** Replaced with a type predicate. Structural narrowing stays: `obsidian` ships types only, so naming `TFile` in a value position would break the Node test environment. |
| Unnecessary type assertion (`settings.ts`) | Warning | **Fixed in 0.10.0.** |
| PluginSettingTab does not implement `getSettingDefinitions()` | Warning | **Fixed in 0.10.0** — this milestone. |
| `display` is deprecated since 1.13.0 | Recommendation | **Resolved in 0.12.0 by deleting it.** Kept deliberately through 0.11.4, because removing it meant raising `minAppVersion` from 1.7.2 to 1.13.0 and so ending update delivery to anyone on an older Obsidian. The maintainer took that trade at the 0.11.4 review. Before the deletion the declarative path was diffed against every row `display()` rendered — 35 labels — and found to cover all of them; the one real gap was the top-level "nothing is written outside the vault" paragraph, which had **no** declarative equivalent and so had already been invisible to every 1.13+ user, and which is now a definition of its own. `versions.json` keeps mapping releases up to 0.11.4 to 1.7.2, so older apps are offered 0.11.4 rather than stranded. |
| Use `window.setTimeout()` / `window.clearTimeout()` (9 sites) | Warning | **Fixed on the 0.11.x track**, superseding the earlier "not applicable" reading. The rule targets timers whose lifetime is tied to a popout window, and calling `window.*` directly was rejected because the core and server layers must also run under Node — where `window` does not exist and every unit test lives — so it would have meant shimming a browser global into the test environment and giving the pure core a host dependency. `utils/timeout.ts` now exports `setTimer`/`clearTimer`, which resolve the host per call: a real window gets window-owned timers, Node gets the global. All nine sites route through it, so `src/` contains no bare `setTimeout`/`clearTimeout` identifier at all — the Node fallback reaches the global as `globalThis.setTimeout`, since a bare call is exactly what the scan matches and writing one would have traded nine warnings for two. The three UI files that own a popout-capable timer keep calling `window.setTimeout` directly. |
| Avoid using `global` (`memory-types.ts:63`) | Warning | **False positive, silenced anyway.** The line was `global: string;`, a property of the `MemoryPaths` interface rather than Node's `global` — but the rule matches the bare identifier, so it would be reported on every release. The field is now `globalDir` (shipped in 0.10.1), which costs four lines and keeps future reviews signal-only. |
| Avoid unnecessary logging to console (`logger.ts:61`, now `:65`) | Warning | **Kept deliberately, re-confirmed at 0.11.3.** `debug`/`info` are gated behind the `debugLogging` setting and are silent by default. `warn`/`error` always emit, on purpose: they are the only channel for degradations the user needs to know about — a corrupt index shard being dropped, an embedding provider refusing a request, a memory file that exists but cannot be read. Gating those too would restore exactly the silent-failure class this cycle spent several releases removing. Every context object is redacted for secret-shaped keys before it reaches the console. |
| Release contains extra unsupported files (`SHA256SUMS`) | Recommendation | **Kept deliberately, re-confirmed at 0.11.3.** Obsidian simply does not download it, so the cost of publishing it is zero. The benefit is not: `scripts/install.sh` verifies every downloaded asset against it and, since 0.11.2, **refuses to install when it cannot be fetched** — removing the file would make every scripted install hit that fail-closed path, and would also break the manual `sha256sum -c SHA256SUMS` step the README documents. Dropping it would mean undoing this cycle's supply-chain hardening to satisfy a recommendation about a file nobody is asked to download. |
| Vault enumeration (`getMarkdownFiles`) | Recommendation | **Inherent, re-confirmed at 0.11.3.** The plugin is a vault indexer; enumerating notes is the feature, not an incidental capability. What bounds it is what happens next: included/excluded folders, excluded tags and excluded path patterns are applied *before* a note's content is read, the index only ever holds notes that survived those filters, and retrieval can only return chunks that are in the index. There is no way to narrow this without removing search. |
| Undescribed directive comment (`embedding-store.ts:268`) | Error (0.11.0) | **Fixed on the 0.11.x track.** One `eslint-disable-next-line no-await-in-loop` in the sharded-load path shipped without the `--` rationale every other disable in the repo carries. It now explains itself like the rest; the repo has no bare disables left. |
| Expected an error object to be thrown (`embedding-store.ts:528`) | Warning (0.11.0) | **Fixed on the 0.11.x track**, and it was a real (if narrow) defect rather than a lint nit. The embedding worker pool captures the first failure into `let failed: unknown` and rethrows it after the pool drains, so a provider rejecting with a non-`Error` (a string, a raw response) propagated that value to callers who all treat a failure as an `Error`. The capture now normalizes with `err instanceof Error ? err : new Error(toMessage(err))`. |
| Expected an error object to be thrown (`embedding-store.ts:531`) | Warning (0.11.3) | **Fixed**, and the whole class is now closed rather than the one reported site. The scan kept reporting rethrows our own lint passed, because `@typescript-eslint/no-throw-literal` defaults `allowThrowingAny` and `allowThrowingUnknown` to **true** — so six `throw err` rethrows of a caught `unknown` were invisible to it. Both options are off now, which surfaced five sites (`obsidian-vault-adapter.ts` ×3, `embedding-store.ts`, `index-manager.ts`), each fixed through a new `asError` helper in `utils/errors.ts`. It is not lint appeasement: an existing `Error` is returned unchanged, so subclass identity and stack survive, while a genuine non-`Error` host rejection — a bare string from the vault adapter, say — stops propagating to callers that all treat a failure as an `Error`. |
| Unsafe `any` in the ZIP inflate loop (`zip.ts`) | Error (locally, under their rule set; never reported in an official review) | **Fixed in 0.10.0.** `pipeThrough` loses the element type, so the inflated chunks were `any` — and the size accounting there is what stands between a crafted archive and an unbounded allocation. The reader is now annotated. |
| Build reproduced the release `main.js` byte-for-byte; attestations verified | Pass | No action. |

## Patch releases since 0.9.0

No new surface — a run of releases fixing what auditing the shipped code turned up. Each is
described in full in [CHANGELOG.md](../CHANGELOG.md); the short version:

| Version | Fix |
| --- | --- |
| 0.15.1 | **Correctness, from the cycle after 0.15.0.** `supersedes` could name a pending proposal or a ledger (the inbox is under the memory root) and hide an unreviewed proposal on apply — refused now. `reindex_vault` rate-limited before its refusal; 413 message client-safe. Block-reference wikilinks resolve; CommonMark fence-length rule (a 3-backtick line no longer closes a 4-backtick block); UTF-16 text attachments decode by BOM; zip directory/entry bounds checks; `using namespace` is not a declaration. Term-major lexical scoring, byte-identical scores pinned by a golden test, 26–40% faster in A/B. No index rebuild. |
| 0.15.0 | **Privacy and data safety, from four review cycles.** Four more exclusion fail-opens (leading `/` in a path pattern, `**` needing a directory on each side, a wrapped `tags:` list, a tag not covering its children — the last a deliberate widening, matching Obsidian, and the reason `INDEX_VERSION` is 8). A discarded proposal came back through search as unlabelled memory. Two append-overwrite races. An interrupted write's parked file is restored at load, proven on real Obsidian. Path redaction leaked after any separator the allowlist did not name; the Host check ignored the bound address for loopback spellings; project names are now NFC, stripped of control/format characters, bounded, and never a Windows device name. RTF CP1252, a malformed `\\bin`, one bad slide discarding a deck, a silent embeddings-cache discard, MMR 6× faster with identical output, concurrent shard load, retrieval mode on the control panel. Measured and declined: three query-path micro-optimizations and the all-unchanged refresh (2.1 ms at 9k chunks). |
| 0.14.1 | Six fixes from the post-0.14.0 review loop, three of them silent. A heading line longer than the chunk window drove the per-piece budget to its floor and the body was sliced one character per chunk, so the note could not be found by searching for anything written in it. An ordinary `## ` line inside applied memory ended a retired section early, and a non-canonical `supersedes` path was keyed as typed while every consumer keyed the real note path — both made superseding report success and keep serving the retired memory. `tokenBudget` could be overrun nearly sixfold by one result, because nothing bounded the heading every result label embeds. Plus a truncation notice added on top of a cap rather than against it, a truncation that could split a surrogate pair, and `get_note_context` calling a fully-retired note "not indexed". The scale benchmark's corpus gained fenced code — it had none, so it could not see the symbol index it was being used to judge. **No `INDEX_VERSION` bump** (deliberate; see the release notes). |
| 0.9.1 | RTF extraction stopped walking a document one character at a time (19 MB: 1.2 s and 212 MB of heap → 91 ms and 23 MB, byte-identical output). |
| 0.9.2 | An excluded folder typed in a different case silently indexed the notes it named. |
| 0.9.3 | `list_projects` was the only tool with no rate limit. |
| 0.9.4 | One empty note made every startup rewrite the whole index. |
| 0.9.5 | Startup stopped re-reading every note in the vault (the index now records which scan config its mtimes were gathered under). |
| 0.9.6 | That optimization was reaching only new users; an index from an older version never acquired the record. |
| 0.9.7 | Toggling **Index text inside images** did nothing until an unrelated edit — including turning it *off*, which left extracted text searchable. |
| 0.9.8 | `list_projects` was the only read tool with no output cap (1 000 projects returned 197 KB). |
| 0.9.9 | An exclusion naming an accented folder, tag, or pattern silently matched nothing across macOS's decomposed filenames. |
| 0.10.1 | Housekeeping so Obsidian's automated plugin review reports nothing worth reading; no behaviour change. |
| 0.10.2 | The declarative settings tab accepted a port or batch size outside its range — `min`/`max` are input hints, not a bound the app enforces. |
| 0.10.3 | Four fixes: a tool error disclosed the vault's absolute path; each of the three caches under `Index/` trusted its contents; and a discarded memory could reappear. |
| 0.10.4 | The plugin assumed text was ASCII: lexical search tokenized Russian, Greek, Japanese, Chinese and Hebrew notes into **nothing**, and an excluded inline tag like `#privé` was misread so the privacy filter failed open (`INDEX_VERSION` bumped to drop the affected notes). |
| 0.10.5 | The extractive summarizer kept its **own** ASCII-only word pattern after 0.10.4 fixed retrieval's, so `summarize_note` scored every non-Latin sentence 0 and quietly returned the first N sentences instead of the most representative ones. Plus three hot-path economies: an all-unchanged refresh skips the embedding pass's whole-corpus hash sweep, scan include/exclude rules compile once per scan instead of once per file, and `find_related_notes` caches the link graph per index change. |
| 0.10.6 | Two fixes from the post-0.10.5 review loop: a corrupt settings blob with a non-string `server.token` crashed server startup (violating the documented degrade-without-throwing invariant), and a pending memory whose content ends in a "Related files:"-shaped list was mis-parsed — the tail silently became related-path metadata. Plus three more economies (cached vector norms, per-chunk content-hash memoization, O(1) per-note chunk lookup) and supply-chain hardening: CI/release workflow actions pinned to commit SHAs. |
| 0.10.7 | The large-vault P1 set: `embeddings.json` v2 stores vectors as binary Float32 bytes with precomputed norms (~40% smaller, migrated in place — no re-embed), lexical retrieval scores only the union of the query terms' posting lists instead of the whole corpus, the embedding pass checkpoints every ~1,024 chunks so an interrupted first pass resumes, and a new Concurrent batches setting (default 1) speeds first passes against local providers. |
| 0.11.1 | A hardening pass over the subsystems 0.11.0's persistence work did not touch. **Tag extraction failed open twice** — an inline tag was only recognized after whitespace or `(`, so `**#private**`, `urgent,#private,todo` and `"#private"` extracted nothing, and an unterminated frontmatter block discarded its `tags:` list — meaning notes the user had excluded were indexed and served (`INDEX_VERSION` bumped to 4 to evict them). Also: the last chunk of a note ending in a newline reported an `endLine` past the end; `summarize_note` split sentences on abbreviation periods; `add_memory` re-parsed the whole review inbox per call (now mtime-cached); and the two source findings from Obsidian's automated 0.11.0 review are closed. |
| 0.11.2 | A correctness and honesty release. **Three ways tag exclusion could fail open** — a UTF-8 BOM hid a note's whole frontmatter block, an unterminated block discarded its `tags:` list, and an inline tag was missed after most punctuation — each letting a note the user had excluded be indexed and served (`INDEX_VERSION` 5). Two costs 0.11.1 introduced: an index-version bump forced a full **paid re-embed**, and hybrid search then silently degraded to lexical while still reporting "hybrid". Also: a settings change mid-pass could discard a whole reindex, a blank Excluded-folders entry disabled indexing outright, the inbox dedup cache could drop a new memory, and `scripts/install.sh` installed unverified when its checksum manifest could not be fetched. The plugin stopped claiming embedding updates it had not performed. |
| 0.14.0 | **Memory that can be revised, not only appended** — the five open items from the agent-capability ranking, plus the deferred inbox-parse cost. A discard now records the proposal and the reviewer's reason in a **rejection ledger**, and `list_rejected_memory` reads it back, so a rejection stops being indistinguishable from an entry nobody has reviewed. A proposal can name the memory it **supersedes**; applying it retires that section from search, both context reads, note reads and symbol lookup, without ever overwriting the text — the ledger is the record and deleting one entry undoes it. Every proposal is scored for **overlap** against existing memory, so a changed fact is re-proposed as a replacement rather than accumulating beside the old one. **Memory ageing** (opt-in, memory-only, floored, dated per memory from its own heading) makes recency a ranking signal instead of an all-or-nothing filter. Tools return **structured results** beside their prose, and accept a **`tokenBudget`**. Chunks record the **symbols their fenced code declares**, with a scoring credit and a `find_symbol` lookup. `readInbox` is cached, and the four mtime-keyed caches became one. Six defects were found by the per-stage security and simplification gates and fixed before release, each with a regression verified to fail without its fix — the two most serious being an unbalanced code fence in applied content that could silently hide every later section of a memory file, and a structured payload that escaped the `maxChars` cap by 491 KB. **Rebuilds the index once** (`INDEX_VERSION` 6→7). |
| 0.13.0 | **Four new MCP tools, closing loops an agent could not close before.** `list_pending_memory` lets an agent see its own proposals — `add_memory` reported only that one landed, so it re-proposed facts it had already contributed and the writer's dedup silently absorbed them. `get_recent_changes` answers "what moved since I last looked" from the index's note→mtime map: no query, no scoring, no I/O. `resolve_project` maps a working directory or repo name to the project name the vault actually uses, and the same fix landed on the **Default project** setting in Obsidian, which had the identical silent miss. `search_batch` runs several related queries in one call and merges them by Reciprocal Rank Fusion, so agreement across queries becomes a ranking signal that does not exist when the questions are asked separately. Also fixed: memory dedup missed a case-variant project name, holding open the very re-proposal loop the first tool closes. `fuseByRank` and `candidateDepthFor` were extracted from `HybridRetriever` at their second use and are now shared. **No index rebuild.** |
| 0.12.1 | **Security: an over-complex excluded path pattern stopped excluding anything.** Past the safety caps (256 characters or 12 wildcards) a pattern is not compiled to a RegExp — the `[^/]*` and `.*` a glob expands to backtrack catastrophically once combined — and the fallback stripped the wildcards and tested `includes` on the remainder, turning `Private/**/*.md` into the literal `Private/.md`. The exclusion matched nothing and the notes it was meant to hide were indexed and served over the MCP server, silently. The fallback is now an ordered-literal match that is a deliberate superset of the glob, and the degradation is logged. **No `INDEX_VERSION` bump** — verified, not assumed: path eligibility is re-evaluated on every scan including the mtime fast path, so the first refresh evicts anything wrongly indexed. |
| 0.12.0 | **`minAppVersion` raised to 1.13.0**, which let the imperative settings tab go — about 450 lines duplicating every settings row, which Obsidian has ignored since 1.13 whenever `getSettingDefinitions()` returns anything. Older apps are not stranded: `versions.json` still maps releases up to 0.11.4 to 1.7.2, so they are offered 0.11.4 and keep a working plugin. The deletion was gated on diffing the two paths row by row (35 labels, all covered), which turned up one real gap — the sentence stating that nothing is written outside the vault existed only in the imperative tab, so 1.13+ users had already stopped seeing it; restored as a definition. `npm test` now also fails if the README's stated minimum Obsidian version drifts from the manifest, which caught this release's own stale line. |
| 0.11.4 | A review-and-hardening release with **no user-visible behaviour change and no index rebuild**. Two server guards made to fail closed: the DNS-rebinding check compared the `Host` hostname against the bound host without requiring either to be non-empty, and a whitespace-only configured host survived its `127.0.0.1` fallback to bind every interface. Retrieval and summarization now hold their own vector invariants rather than trusting the caller — the stored cosine norm is recomputed instead of read back on faith, where a desynced one would inflate a score past 1 and outrank every honest match. Property fuzzing closed four contract gaps, one reachable (`add_memory` with a blank related path wrote a malformed bullet the parser then dropped). Both remaining Obsidian review findings closed at the class level: `no-throw-literal` runs with `allowThrowingAny`/`allowThrowingUnknown` off and every rethrow goes through `asError`, and all nine timer sites schedule through a host-aware `setTimer`/`clearTimer`. |
| 0.11.3 | Two more tag-exclusion fail-opens, **one a regression 0.11.2 introduced**: bounding the unterminated-frontmatter scan also stopped it after a genuine key had established the block, so tags behind merge-conflict markers or a stray line were lost (0.11.1 found them, 0.11.2 did not). Separately, a blank line or comment inside a `tags:` block list cleared the key its items belong to and dropped every tag after it — this one affects ordinary terminated frontmatter and predates 0.11.2. `INDEX_VERSION` 6. |

Five themes run through them, and they are worth stating because they are where the next
bug probably is: a filter that fails **open** is invisible (0.9.2, 0.9.7, 0.9.9); a tool that
looks cheap gets bounded last (0.9.3, 0.9.8); an optimization is not delivered until it
is verified on the state an *upgrading* user actually has on disk (0.9.6); a file in the vault
is untrusted input even when this plugin wrote it, because sync did not (0.10.3); and a
guarantee attached to an object the code replaces is not a guarantee (0.10.3, where the inbox
lock lived on a writer that every settings change rebuilt); and an ASCII-only character class is
a bug in every language but one (0.10.4, and a third copy of the class surfaced in the
summarizer for 0.10.5) — the same lesson as 0.9.9, which fixed it for
frontmatter tags and left the inline path untouched, so **when a fix has two code paths, test the
one the fix did not come from**.

A sixth, about method rather than code: **a probe that cannot detect the bug proves nothing
about its absence.** Three separate investigations in this run first returned a clean result
from an instrument that was measuring nothing — a fixture built on the wrong `INDEX_VERSION`,
a race probe aimed at the one inbox operation that appends rather than rewrites, and an e2e
suite that skips with exit 0 when `DISPLAY` is unset. Each was caught by running the negative
control: assert the *unbroken* case still passes, or force the failure and confirm the probe
sees it.

## In progress (unreleased)

- Nothing unreleased — 0.15.1 has just been cut.

### What 0.15.1 carried

- **A correctness release**, described in full in [CHANGELOG.md](../CHANGELOG.md).
  The one boundary fix: a proposal's `supersedes` reference is refused when it
  names anything under the review inbox, since a pending proposal or a ledger is
  not memory and a proposal must not be able to hide another that nobody has
  reviewed. Two server consistency gaps (`reindex_vault` limiter order, the 413
  message form), five extraction and link defects, and a lexical scoring rewrite
  measured at 26–40% with output pinned identical. The scale benchmark was
  re-run and recorded; its spread exceeded the change, which is why the A/B
  harness is the cited number.

### What 0.15.0 carried

- **A privacy release**, described in full in [CHANGELOG.md](../CHANGELOG.md).
  Four more ways an exclusion covered less than it read as — a leading `/` in a
  path pattern matching nothing, `**` refusing to match zero directories, a
  wrapped `tags:` flow sequence losing every tag after the first line, and a tag
  exclusion not covering that tag's children. That last one is a deliberate
  widening and the only user-visible semantic change: notes carrying a child of
  an excluded tag leave the index on the next refresh.
- **A discarded proposal came back as ordinary memory.** The rejection ledger
  is indexed like any other note, so the claim the reviewer turned down was
  returned by search as an unlabelled hit that even reported
  `pendingReview: false`. `find_symbol` had already excluded the ledgers for
  this reason; search had not. Both are excluded now, and the pending file stays
  searchable and labelled, which is the feature.
- **An append could overwrite.** The adapter's append writes a missing file
  instead, and two concurrent appends to a not-yet-existing file both took that
  path. Appends are serialized; the one memory-write path doing an unlocked
  read-modify-write now takes the shared lock.
- **An interrupted write is recovered at load.** The crash window between
  the write path's two renames left a file parked under a backup name with
  nothing at its own path, and no sweep existed. Startup now repairs it under
  the plugin root by rule (restore a backup whose target is missing; remove one
  whose target exists; remove temps), proven against the real host `list()` by
  an e2e scenario that plants a parked file before launch.
- **The DNS-rebinding guard checks Host against the bound address in every
  mode.** A loopback-shaped Host was accepted whatever the server was bound to,
  so a LAN bind under `allowNonLocalhost` passed `Host: localhost`. Bounded —
  the token check runs next — but it was the one defence layer removed in the
  one mode where it matters, and it contradicted SECURITY.md.
- **A sharded embeddings cache loads concurrently**, as the chunk index
  already did: 512 sequential round trips became one pass (1.1 s to 12 ms at a
  fixed 2 ms per call). The control panel now shows the retrieval mode actually
  serving results and whether vectors exist to serve it.
- **Project names are made safe at the boundary that promises it** — NFC,
  control/format characters stripped, Windows device names refused, 255-byte
  bound — and a memory file that cannot be read is reported to the agent as
  such rather than rendered like an empty one.
- Recorded, not done: memory files are read whole before the output cap
  applies (they grow by append, so a very large one is read in full on every
  context call — bounding it needs a partial-read adapter API); and the MCP
  helpers cap lengths in UTF-16 units, which only ever tightens a limit for
  astral text.
- Alongside them: the embedding-provider factory could throw from the function
  documented as never throwing (a non-string endpoint met optional chaining); an
  error message could still disclose the vault's absolute
  path after any separator the old allowlist did not name; RTF decoded Word's
  default punctuation to invisible control characters, breaking the words it sat
  inside; a malformed `\bin` count truncated an RTF document; one unreadable
  slide discarded a whole presentation; and an unrecognized embeddings cache
  discarded every vector without a word.
- **`INDEX_VERSION` 7 → 8, and the reason is the fix itself.** Path and folder
  rules are re-applied to every path on every scan, so those three fixes reach an
  existing index on the first refresh — verified, the same reasoning 0.12.1
  recorded. Tag eligibility is different: it needs the file's CONTENT, and a note
  whose mtime has not moved is never re-read. Verified too, by scanning with the
  note's own mtime already known: `#private/secret` came back unchanged, so the
  widened exclusion would never have reached the vaults that already have such a
  note. A privacy fix that only applies to notes edited after the upgrade is not
  delivered. The cost is one local re-chunk and **no re-embed** — vectors are
  keyed by content hash and survive a chunk-index rebuild. The RTF and office
  extraction fixes still reach a note only when its mtime moves, since extraction
  is cached separately; touching the attachment re-extracts it.

### What 0.14.1 carried

- **A correctness release from the post-0.14.0 review loop**, described in full
  in [CHANGELOG.md](../CHANGELOG.md). Four defects, three of them silent: a note
  whose heading line was longer than the chunk window had its body sliced one
  character per chunk, so the note could not be found by searching for anything
  written in it; an ordinary `## ` line inside applied memory content ended a
  retired section early, so superseding reported success and kept serving the
  memory it had retired; a `supersedes` reference that was not already canonical
  recorded a retirement that could never match; and `tokenBudget` could be
  exceeded nearly sixfold by one result, because nothing bounded the heading
  every result label embeds. Plus the two gaps that let these stay invisible —
  the benchmark corpus contained no fenced code, so it could not see the symbol
  index it was being used to judge, and three documents said seven tools return
  `structuredContent` when the code and its own test said eight.
- **No `INDEX_VERSION` bump.** Chunking is re-run only for a note whose mtime
  moved, so a vault that already holds a pathological heading keeps its shredded
  chunks until that note is edited. Forcing every user to re-index and re-embed
  one release after 0.14.0 already did, for a pathology this rare, was judged the
  worse trade — recorded here because it is a deliberate limit on the fix, not an
  oversight.

### Agent-capability track (opened in 0.13.0, completed in 0.14.0)

Ten expansions were ranked by cost against reward for Claude Code, and the four
cheapest-with-highest-reward shipped in 0.13.0: `list_pending_memory`,
`get_recent_changes`, `resolve_project`, and `search_batch`. What they had in
common is that the machinery already existed — an engine method, a filter, a
fusion routine — so each was a thin query over something built and tested.

All five remaining items shipped in 0.14.0, together with two that were ranked
alongside them (proposal-outcome feedback and contradiction detection at propose
time) and the `readInbox` cost this section recorded as deferred:

1. **Supersede a stale memory** — shipped. The block format gained a
   `Supersedes:` field (round-trip held), retirement is append-only through a
   ledger, and the review card names what a proposal will retire.
2. **A per-call token budget** — shipped as `tokenBudget` on the nine tools
   whose output can be large.
3. **Structured results** — shipped for the eight tools whose answers are lists,
   each declaring an `outputSchema`, with `content` unchanged.
4. **Code-aware chunking and a symbol index** — shipped, and it is why this
   release rebuilds the index.
5. **Retrieval feedback** — **still open**, and still the right call to defer.
   Highest ceiling, lowest certainty; it adds persisted state and should not
   ship before `npm run eval` can measure whether it helps. Nothing in 0.14.0
   changed that reasoning.

What 0.14.0 measured about its own cost is in
[RAG_PIPELINE.md](RAG_PIPELINE.md): lexical queries got ~9% slower at 14k
chunks (13.9 → 15.1 ms p50) for the symbol terms, the supersession probe and the
ageing pass. Recorded rather than smoothed over, and the first place to look if
query latency becomes the binding constraint.

Deliberately NOT taken: letting the agent append to the session note. It reads
as continuity but the inbox-first invariant means it would have to queue for
review, which makes it another proposal queue rather than a journal. Changing
that is an invariant decision in its own right, not a feature to slip in
alongside others.

The cost 0.13.0 documented rather than fixed — `readInbox` uncached while
`proposeToInbox` kept a dedup cache, so checking before proposing parsed the
same file twice — was fixed in 0.14.0, along with collapsing the three
mtime-keyed caches that had accumulated into one.

**Next, in order**, per [LARGE_VAULTS.md](LARGE_VAULTS.md):

1. **P2.2 lazy chunk text** — `IndexedChunk.text` moves behind a chunk-handle accessor, with tokenize/stats caches persisted per shard so BM25 never needs the body. Resident heap per chunk drops from roughly 2 KB to 200 B, putting 1M chunks near 1 GB with vectors. This is the API-breaking step and lands alone on purpose: `text` is read by the chunker, all three retrievers, the summarizer, the MCP tools, and memory search.
2. **P3.1 IVF vector search** behind the existing `Retriever` interface, plus the **P3.2 large-vault mode** switch. Gated on a real-vault recall eval added to `npm run eval` — the spike's 43–57× speedup at ≥99.7% recall was measured on a deliberately clustered synthetic corpus, which flatters recall. LARGE_VAULTS.md also records a measured ~22 ms of a 65.7 ms vector query spent on a full sort that a bounded top-K would reclaim; that change is deliberately deferred to this step rather than made as a patch, because it reorders tied results.
3. **P2.3 Web Worker offload** for initial chunking, wherever in-Obsidian verification is available. The cooperative-yield fallback shipped in 0.11.0 already removes the renderer-freeze failure mode, so this is throughput rather than correctness.

Standing work between releases: the review loop that produced 0.10.1–0.13.0 keeps running — audit what is already shipped, fix what fails open first, and treat a stale document as an unfinished release. Nine passes in, the highest-yield technique has been pointing an adversarial review at the *previous pass's own commits*: it found a real defect in five consecutive ones.

## Open questions for the maintainer

- **Enforce `additionalProperties: false` on MCP tool arguments?** All fourteen tools advertise it in
  their `inputSchema`; no handler enforces it, so an extra key is currently ignored rather than
  refused. This is not a vulnerability — unknown keys never reach a sink — but the schema
  promises something the server does not do. Enforcing it is a breaking change for any client
  that sends an extra key, so it is a product decision, not a fix.

## Deferred / future

- **MCP revision 2026-07-28.** This server implements 2025-06-18 and negotiates it honestly (see docs/MCP_SERVER.md); the current revision has since moved twice (2025-11-25, then 2026-07-28). The newer revision is a base-protocol rewrite, not a tools change: it removes the `initialize`/`notifications/initialized` handshake and `ping` in favour of a stateless model where each request carries `io.modelcontextprotocol/protocolVersion` in `_meta`, requires a new `server/discover` RPC, and answers a version mismatch with `UnsupportedProtocolVersionError`. The tool surface is untouched — `tools/list` and `tools/call` still use `inputSchema`, `content`, `isError`, and `nextCursor` — so the work is confined to the protocol layer. **Not urgent:** the spec explicitly permits a server to implement both eras ("A server that wishes to support both legacy clients … and modern clients … MAY implement both behaviors"), and its own compatibility matrix has legacy-client/legacy-server working, which is what Claude Code does today.
- Non-desktop support (currently `isDesktopOnly`).
- Scanned-PDF OCR. The same delegation would need Text Extractor's PDF path, which its own README flags as unreliable.
- Cost control for a first refresh over thousands of images: OCR is serial and expensive per cache miss, and capping the work per scan would mean partial-index semantics.
- Alternative local vector stores (SQLite, LanceDB, DuckDB) behind the storage model.
