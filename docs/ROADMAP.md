# Roadmap

Coder Engram is built in milestones. Milestones 1 through 15 are complete (through 0.11.0); the patch releases from 0.9.1 to 0.11.3 are listed under "Patch releases since 0.9.0", the Obsidian review findings and what was done about each under "Plugin review findings", work not yet released under "In progress", and anything not scheduled under "Deferred / future".

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
0.9.9 review is resolved except the four entries marked "kept" or "not applicable" below,
which are deliberate and expected to recur. Build verification passed again: the release
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

- The four "kept"/"not applicable"/"inherent" entries were re-confirmed deliberately, with
  the trade-off each one buys written out in its row. They are expected to recur in every
  future review, and the rows exist so a reviewer can see the decision instead of
  re-deriving it.
- Build verification reproduced the release `main.js` byte-for-byte again, and both it and
  `styles.css` carry verified attestations.

| Finding | Severity | Resolution |
| --- | --- | --- |
| `Plugin.settings` requires 1.13.0 but minAppVersion is 1.7.2 (`settings-tab.ts`) | Error | **Fixed in 0.10.0.** Obsidian 1.13 added its own `Plugin.settings`, and the tab held its host as `Plugin & SettingsHost`, so the read resolved to Obsidian's property. The host is now held at its `SettingsHost` type. |
| Avoid casting to `TFile` (`obsidian-ocr-extractor.ts`) | Warning | **Fixed in 0.10.0.** Replaced with a type predicate. Structural narrowing stays: `obsidian` ships types only, so naming `TFile` in a value position would break the Node test environment. |
| Unnecessary type assertion (`settings.ts`) | Warning | **Fixed in 0.10.0.** |
| PluginSettingTab does not implement `getSettingDefinitions()` | Warning | **Fixed in 0.10.0** — this milestone. |
| `display` is deprecated since 1.13.0 | Recommendation | **Kept deliberately, re-confirmed at 0.11.3.** Obsidian ignores `display()` entirely as soon as `getSettingDefinitions()` returns anything, so every user on 1.13+ already gets the declarative tab and this code never runs for them. It exists solely as the pre-1.13 fallback. Removing it would require raising `minAppVersion` from 1.7.2 to 1.13.0, which stops delivering updates to anyone on an older Obsidian — a real cost to real users in exchange for silencing a recommendation that has no functional effect. |
| Use `window.setTimeout()` / `window.clearTimeout()` (9 sites) | Warning | **Not applicable, re-confirmed at 0.11.3.** The rule targets timers whose lifetime is tied to a popout window; none of these are. Every site is listed here so a reviewer does not have to re-derive it: `utils/timeout.ts:20,25` (the shared timeout race, used by the PDF extractor and the HTTP adapter), `utils/debounce.ts:29,30,37` (the auto-index debounce), `server/local-server.ts:261,271` (the bind timeout), and `indexing/index-manager.ts:334,406` (the two cooperative yields that keep a large rebuild from freezing the renderer). **All nine are unit-tested under the Node test environment, where `window` does not exist**, so qualifying them would mean shimming a browser global into the tests and giving the pure core a `window` dependency — trading a documented architectural property (the core runs anywhere) for a cosmetic warning. The three UI files that *do* own a popout-capable timer — `pending-memory-modal.ts`, `simple-modals.ts`, `search-modal.ts` — correctly call `window.setTimeout`, which is what makes the split deliberate rather than accidental. |
| Avoid using `global` (`memory-types.ts:63`) | Warning | **False positive, silenced anyway.** The line was `global: string;`, a property of the `MemoryPaths` interface rather than Node's `global` — but the rule matches the bare identifier, so it would be reported on every release. The field is now `globalDir` (shipped in 0.10.1), which costs four lines and keeps future reviews signal-only. |
| Avoid unnecessary logging to console (`logger.ts:61`) | Warning | **Kept deliberately, re-confirmed at 0.11.3.** `debug`/`info` are gated behind the `debugLogging` setting and are silent by default. `warn`/`error` always emit, on purpose: they are the only channel for degradations the user needs to know about — a corrupt index shard being dropped, an embedding provider refusing a request, a memory file that exists but cannot be read. Gating those too would restore exactly the silent-failure class this cycle spent several releases removing. Every context object is redacted for secret-shaped keys before it reaches the console. |
| Release contains extra unsupported files (`SHA256SUMS`) | Recommendation | **Kept deliberately, re-confirmed at 0.11.3.** Obsidian simply does not download it, so the cost of publishing it is zero. The benefit is not: `scripts/install.sh` verifies every downloaded asset against it and, since 0.11.2, **refuses to install when it cannot be fetched** — removing the file would make every scripted install hit that fail-closed path, and would also break the manual `sha256sum -c SHA256SUMS` step the README documents. Dropping it would mean undoing this cycle's supply-chain hardening to satisfy a recommendation about a file nobody is asked to download. |
| Vault enumeration (`getMarkdownFiles`) | Recommendation | **Inherent, re-confirmed at 0.11.3.** The plugin is a vault indexer; enumerating notes is the feature, not an incidental capability. What bounds it is what happens next: included/excluded folders, excluded tags and excluded path patterns are applied *before* a note's content is read, the index only ever holds notes that survived those filters, and retrieval can only return chunks that are in the index. There is no way to narrow this without removing search. |
| Undescribed directive comment (`embedding-store.ts:268`) | Error (0.11.0) | **Fixed on the 0.11.x track.** One `eslint-disable-next-line no-await-in-loop` in the sharded-load path shipped without the `--` rationale every other disable in the repo carries. It now explains itself like the rest; the repo has no bare disables left. |
| Expected an error object to be thrown (`embedding-store.ts:528`) | Warning (0.11.0) | **Fixed on the 0.11.x track**, and it was a real (if narrow) defect rather than a lint nit. The embedding worker pool captures the first failure into `let failed: unknown` and rethrows it after the pool drains, so a provider rejecting with a non-`Error` (a string, a raw response) propagated that value to callers who all treat a failure as an `Error`. The capture now normalizes with `err instanceof Error ? err : new Error(toMessage(err))`. |
| Expected an error object to be thrown (`embedding-store.ts:531`) | Warning (0.11.3) | **Fixed. A second, distinct instance of the same rule — and a genuine one, not a repeat of the 0.11.0 fix.** The embedding worker pool captured its first failure into a closure-assigned `let`. TypeScript's control-flow analysis does not track writes made inside a closure, so at the rethrow it still believed the variable held its initialiser: the thrown value typed as `null`, i.e. the checker considered the failure path unreachable. Verified by forcing the compiler to print the resolved type — annotating the union did not help, because narrowing re-derives it from the initialiser. The failure is now held in an `Error[]`, whose element type is unconditional, so the rethrow types as the Error it actually is. |
| Unsafe `any` in the ZIP inflate loop (`zip.ts`) | Error (locally, under their rule set; never reported in an official review) | **Fixed in 0.10.0.** `pipeThrough` loses the element type, so the inflated chunks were `any` — and the size accounting there is what stands between a crafted archive and an unbounded allocation. The reader is now annotated. |
| Build reproduced the release `main.js` byte-for-byte; attestations verified | Pass | No action. |

## Patch releases since 0.9.0

No new surface — a run of releases fixing what auditing the shipped code turned up. Each is
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
| 0.10.1 | Housekeeping so Obsidian's automated plugin review reports nothing worth reading; no behaviour change. |
| 0.10.2 | The declarative settings tab accepted a port or batch size outside its range — `min`/`max` are input hints, not a bound the app enforces. |
| 0.10.3 | Four fixes: a tool error disclosed the vault's absolute path; each of the three caches under `Index/` trusted its contents; and a discarded memory could reappear. |
| 0.10.4 | The plugin assumed text was ASCII: lexical search tokenized Russian, Greek, Japanese, Chinese and Hebrew notes into **nothing**, and an excluded inline tag like `#privé` was misread so the privacy filter failed open (`INDEX_VERSION` bumped to drop the affected notes). |
| 0.10.5 | The extractive summarizer kept its **own** ASCII-only word pattern after 0.10.4 fixed retrieval's, so `summarize_note` scored every non-Latin sentence 0 and quietly returned the first N sentences instead of the most representative ones. Plus three hot-path economies: an all-unchanged refresh skips the embedding pass's whole-corpus hash sweep, scan include/exclude rules compile once per scan instead of once per file, and `find_related_notes` caches the link graph per index change. |
| 0.10.6 | Two fixes from the post-0.10.5 review loop: a corrupt settings blob with a non-string `server.token` crashed server startup (violating the documented degrade-without-throwing invariant), and a pending memory whose content ends in a "Related files:"-shaped list was mis-parsed — the tail silently became related-path metadata. Plus three more economies (cached vector norms, per-chunk content-hash memoization, O(1) per-note chunk lookup) and supply-chain hardening: CI/release workflow actions pinned to commit SHAs. |
| 0.10.7 | The large-vault P1 set: `embeddings.json` v2 stores vectors as binary Float32 bytes with precomputed norms (~40% smaller, migrated in place — no re-embed), lexical retrieval scores only the union of the query terms' posting lists instead of the whole corpus, the embedding pass checkpoints every ~1,024 chunks so an interrupted first pass resumes, and a new Concurrent batches setting (default 1) speeds first passes against local providers. |
| 0.11.1 | A hardening pass over the subsystems 0.11.0's persistence work did not touch. **Tag extraction failed open twice** — an inline tag was only recognized after whitespace or `(`, so `**#private**`, `urgent,#private,todo` and `"#private"` extracted nothing, and an unterminated frontmatter block discarded its `tags:` list — meaning notes the user had excluded were indexed and served (`INDEX_VERSION` bumped to 4 to evict them). Also: the last chunk of a note ending in a newline reported an `endLine` past the end; `summarize_note` split sentences on abbreviation periods; `add_memory` re-parsed the whole review inbox per call (now mtime-cached); and the two source findings from Obsidian's automated 0.11.0 review are closed. |
| 0.11.2 | A correctness and honesty release. **Three ways tag exclusion could fail open** — a UTF-8 BOM hid a note's whole frontmatter block, an unterminated block discarded its `tags:` list, and an inline tag was missed after most punctuation — each letting a note the user had excluded be indexed and served (`INDEX_VERSION` 5). Two costs 0.11.1 introduced: an index-version bump forced a full **paid re-embed**, and hybrid search then silently degraded to lexical while still reporting "hybrid". Also: a settings change mid-pass could discard a whole reindex, a blank Excluded-folders entry disabled indexing outright, the inbox dedup cache could drop a new memory, and `scripts/install.sh` installed unverified when its checksum manifest could not be fetched. The plugin stopped claiming embedding updates it had not performed. |
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

- **Typed-lint gap closed and a second `no-throw-literal` instance fixed.** The rule is not part of `recommended-requiring-type-checking`, so two real defects of the same shape reached Obsidian's review scan instead of failing our own lint; `npm run lint` now names it explicitly. Two neighbouring options were surveyed and left off with counts recorded in [DEVELOPMENT.md](DEVELOPMENT.md).
- **Server-layer security pass: the rebinding guard now fails closed.** `isHostHeaderAllowed` compared the Host hostname to the bound host without requiring either to be non-empty, and `validateConfig` let a whitespace-only host survive its `|| "127.0.0.1"` fallback and bind every interface. Neither was practically attackable (both need the non-localhost opt-in, which forces a token), but a guard that reads two empty strings as agreement is the wrong shape. The pass also **verified and left alone**, so the next one does not re-derive them: the Origin check normalizes with `new URL` before comparing (probed against IDNA lookalikes in both directions), `resolveInVault` holds against absolute/UNC/drive-relative/`..`-underflow forms, the authorization header is never logged, and the failed-auth lockout array cannot grow past its max. One candidate was investigated and **reverted**: a `__proto__` shard key does mutate the merge accumulator's prototype, but that prototype is unreachable through own-property-only APIs, and the guard's test passed identically with the guard removed.
- **Four contract gaps closed, found by property fuzzing.** A generative hunt over the chunker, the inbox round-trip, index-refresh idempotence, and settings migration came back clean on the properties that matter in production (chunker range/ordering/coverage/containment across 6,000 documents at the shipped defaults; refresh idempotence across 900 checks; `migrateSettings` never throwing across 8,000 adversarial blobs). Four violations survived, one of them reachable today: `add_memory` with a blank `relatedPaths` entry wrote a bare `* ` bullet into the file the user reviews, which the parser then silently dropped. The other three were latent — a non-string `defaultProject` deferred a `TypeError` to the first project command rather than degrading at load, optional inbox fields vanished across a render/parse/render cycle, and `chunkMarkdown` shredded text one character per chunk when a caller passed `overlapChars >= maxChars`. **No `INDEX_VERSION` bump:** the chunker change is a no-op at the shipped defaults (`IndexManager` passes no `ChunkOptions`, and 150 of 2000 is far under the new cap), and a test asserts default output is unchanged. One finding was deliberately not fixed — the packer overshoots `maxChars` by 1–2 characters, which is within a contract that documents it as a soft maximum.
- **The vector-math invariants now live at each consumer.** A retrieval-math review verified the core formulas correct (BM25, the Lucene-variant IDF, RRF, MMR, cosine) and turned up three places where a consumer inherited an invariant from its caller rather than holding it: `extractiveSummary` could return an *empty* summary still labelled `method: "embedding"` if one sentence vector held a non-finite component (a probe through the real engine confirmed the shipped providers cannot produce that — the HTTP layer's `parseVectorMatrix` rejects it — so this was latent, not live); `EmbeddingStore.entriesMap` read the persisted norm back on faith, where a desynced norm inflates that entry's cosine past 1 and outranks every honest match; and `VectorRetriever`'s two norm guards were `=== 0`, which a NaN norm passes. Each has a regression test that fails without its fix.

**Next, in order**, per [LARGE_VAULTS.md](LARGE_VAULTS.md):

1. **P2.2 lazy chunk text** — `IndexedChunk.text` moves behind a chunk-handle accessor, with tokenize/stats caches persisted per shard so BM25 never needs the body. Resident heap per chunk drops from roughly 2 KB to 200 B, putting 1M chunks near 1 GB with vectors. This is the API-breaking step and lands alone on purpose: `text` is read by the chunker, all three retrievers, the summarizer, the MCP tools, and memory search.
2. **P3.1 IVF vector search** behind the existing `Retriever` interface, plus the **P3.2 large-vault mode** switch. Gated on a real-vault recall eval added to `npm run eval` — the spike's 43–57× speedup at ≥99.7% recall was measured on a deliberately clustered synthetic corpus, which flatters recall. LARGE_VAULTS.md also records a measured ~22 ms of a 65.7 ms vector query spent on a full sort that a bounded top-K would reclaim; that change is deliberately deferred to this step rather than made as a patch, because it reorders tied results.
3. **P2.3 Web Worker offload** for initial chunking, wherever in-Obsidian verification is available. The cooperative-yield fallback shipped in 0.11.0 already removes the renderer-freeze failure mode, so this is throughput rather than correctness.

Standing work between releases: the review loop that produced 0.10.1–0.11.3 keeps running — audit what is already shipped, fix what fails open first, and treat a stale document as an unfinished release. Nine passes in, the highest-yield technique has been pointing an adversarial review at the *previous pass's own commits*: it found a real defect in five consecutive ones.

## Open questions for the maintainer

- **Enforce `additionalProperties: false` on MCP tool arguments?** All ten tools advertise it in
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
