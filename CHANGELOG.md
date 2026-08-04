# Changelog

All notable changes to Coder Engram are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A single large attachment can no longer flood the index.** File reads were capped at 50 MB but the text an attachment contributed was not, and the two are only loosely related — the PDF and Office extractors cap pages and parts, yet a plain 50 MB csv, an RTF, or a docx whose whole body sits in one part had no bound at all. A 2.8 MB text file measurably produced 3.04 MB of indexed text across thousands of chunks; extracted text is now capped at 1 MB per attachment and says when it was clipped. 1 MB comfortably holds a whole book (~2 000 characters a page over 500 pages), so real documents are unaffected, and a no-text attachment still indexes as no text rather than as a truncation notice.

### Added

- **Text inside images can be indexed (opt-in), by delegating rather than bundling.** A new **Index text inside images** setting (off by default, schema v6 → v7) reads text out of PNG/JPG/WEBP/BMP attachments through the [Text Extractor](https://github.com/scambier/obsidian-text-extractor) plugin's published API; with that plugin absent, nothing happens and images stay unindexed. Running OCR in-process was rejected on three grounds: Obsidian's developer policy forbids a plugin installing or updating its own dependencies, and an in-process Tesseract fetches a language file on first use; the engine plus one language is megabytes against a ~120 KB bundle; and it would put a network fetch behind a feature users reasonably read as local. Delegating cost **1.2 KB** of bundle instead. **Text Extractor performs that language download itself, so this is the one attachment path that can cause network activity** — stated in the setting's own description. Images obey every existing attachment rule: exclusions are applied before extraction, the 50 MB cap holds, and turning the setting off evicts the extracted text from the cache on the next refresh. The scan also skips reading image files altogether, since the companion plugin works from the path — otherwise enabling this would load every picture in the vault into memory only to discard it.

## [0.8.0] — 2026-08-04

What the agent gets back is now your choice. Three reductions that quietly trimmed MCP tool output are separate opt-in toggles, all off by default — so out of the box nothing is withheld, and each saving is something you turn on knowing what it costs.

### Changed

- **Context savings are now opt-in, and chosen individually.** Three behaviours that trimmed what the MCP tools return are each a separate toggle, all **off by default**: **Collapse near-duplicate hits** (drop a hit whose text nearly repeats a higher-ranked one), **Cap one note's share of a page** (stop one long note filling the whole result page), and **Merge overlapping passages** (join a section's consecutive windows on a full-note read, sending the carried overlap once). They answer different questions — someone who wants every copy of a memory may still want long notes merged sensibly — so a single switch was the wrong shape. Each can withhold something you wanted to see, which is why none is on unless you ask. Settings schema v4 → v6; a v5 `contextSavings` boolean is carried onto all three toggles, so an existing opt-in keeps the behaviour it chose. **The hard output caps are not part of this and always apply** (`maxChars` on note and bulk reads, the related-link and summary budgets) — those bound worst-case size rather than judging content.

## [0.7.1] — 2026-08-04

A crash fix and internal tidying. No settings changes, no index rebuild.

### Fixed

- **A search no longer fails outright when one indexed chunk has an unusable modified time.** The result formatter built each hit's date inline with `new Date(mtime).toISOString()`, which throws `RangeError: Invalid time value` for a non-numeric mtime — taking down the whole `search_vault_memory` response rather than leaving one date blank. The index is a rebuildable cache, so a corrupt or partially-written entry can produce exactly that. The desktop search already had a guarded formatter for this; both now share it.

### Changed

- Internal tidying with no behaviour change: the shared line-normalization and modified-date helpers each have one implementation instead of two, error text everywhere goes through the existing `toMessage` helper, and the settings tab builds its scan-list fields and its sections through shared builders.

## [0.7.0] — 2026-08-04

Every read path an agent can pull on is now bounded by the unit it is actually paid in — characters. Three tools could return far more than their nominal limits suggested (one had no limit at all), and the chunker could emit a single 100 KB chunk against a 1,200-character target. Chunking is also faster and smaller, with the budget set by measured relevance rather than by the cost curve. **Existing indexes rebuild once on upgrade** (`INDEX_VERSION` bumped), since chunk boundaries changed.

### Fixed

- **A paragraph with no blank line in it no longer defeats the chunk budget.** Long sections are windowed on paragraph (blank-line) boundaries, so a paragraph containing none — pasted JSON, base64, a wide table row, prose wrapped without blank lines — passed through whole: a 100 KB paragraph became a single 100,007-character chunk against a 1,200 target, stored in full, sent to the embedding provider as one input, and collapsing that note's retrieval granularity. Such paragraphs are now broken at whitespace into pieces that fit the budget, with a hard slice for a single token that offers no boundary at all (base64 has no spaces). Nothing is dropped, and pieces inherit their paragraph's line span — exact for the common single-line case.

### Changed

- **Sections now chunk at 2000 characters instead of 1200.** Measured at production scale (2000 notes), the larger budget cuts the corpus from 19,132 chunks to 14,407 (−25%), the index from 18.0 MB to 16.1 MB, and lexical p50 latency from 15.8 ms to 10.9 ms (−31%), with correspondingly fewer, larger units to embed. The ceiling is set by relevance rather than cost: cost keeps improving past this, but a fact buried inside a long section holds MRR 1.00 up to 2200 and drops to 0.83 at 2400, because a larger chunk carries more unrelated words and dilutes BM25 term density — which also raised the characters an agent reads before reaching the answer from 274 to 371. Search cost to the agent is otherwise unchanged: snippets are a fixed 220 characters. **Existing indexes rebuild automatically** (`INDEX_VERSION` bumped), since chunk boundaries changed.
- **`summarize_note` now caps its output at 4000 characters.** Sentence count alone never bounded what a summary cost: units are split on lines first, so a line with no sentence terminator — pasted JSON, base64, a wide table row — stays a single unit however long it is. A note built from such lines returned a 20,000-character "summary", more than a full `get_note_context` read, from the one tool whose purpose is cheap context. Over the cap the output is clipped and says so, pointing at a ranged read instead.
- **`find_related_notes` now bounds a hub note's link list.** It was the only content-returning tool with no output bound at all — every other one caps by result count or `maxChars` — so navigating from a Map-of-Content note linking hundreds of notes returned every path, costing more than the largest budgeted read. Each direction now lists up to 1500 characters of links and names how many more it has, so the agent can tell it is seeing a slice rather than the whole graph. The budget is in characters rather than link count deliberately: per-link cost varies ~3.8× with path depth (15 chars for `Notes/n12.md`, 57 for a `Claude Code/Projects/…/Sessions/…` path), so a fixed count bought 759 chars in a shallow vault and 2,859 in a deep one. A link list starts costing more than a whole search page at as few as 6 links when paths are deep.

## [0.6.0] — 2026-08-03

Milestone 10 — attachments become memory, and retrieval gets measured. Opt-in attachment indexing brings PDFs, Microsoft Office and LibreOffice documents, RTF, plain text, and Canvas boards into the same pipeline as notes, all with zero added dependencies and no bytes leaving the machine. Retrieval gains filename/alias/heading field matching (with a golden-query eval harness to prove it), and context handoff gets outline mode, continuation pointers, and labelled bulk reads. Filtered searches are ~8× faster.

### Added

- **PDF attachments can be indexed (opt-in).** A new **Index attachments (PDF)** setting (off by default) extracts text from PDF attachments using **Obsidian's own bundled PDF engine** (the official `loadPdfJs()` API — zero added bundle size, fully local; the file's bytes never leave the machine). Extracted text flows through the exact same pipeline as notes — chunking, incremental refresh, folder/pattern exclusions, search, and every MCP tool work unchanged — with one `Page N` section per page, so search hits carry a page breadcrumb and `outline: true` returns a page map. Extraction runs once per file version and is cached (`Index/extracted.json`), including negative results, so scanned/image-only PDFs (which yield no text in v1 — no OCR) aren't re-parsed every refresh. Settings schema v3 → v4.
- **Microsoft Office and LibreOffice documents are indexed too** (same opt-in setting): docx, pptx, xlsx, odt, odp, and ods. Both families are ZIP archives of XML, so extraction is a small dependency-free reader (the platform's own `DecompressionStream` does the inflating — zero added bundle weight, fully local). Word/Writer documents keep their heading structure; presentations render one `Slide N` section per slide; spreadsheets contribute sheet names and text cells (numeric cell soup is deliberately skipped). Spreadsheets written by streaming exporters (inline strings, no shared-string table) are covered too. Attachments over 50 MB are skipped.
- **Plain text (`txt`/`csv`) and legacy RTF attachments are indexed too** (same opt-in setting; both previously invisible — only `.md` files were ever scanned). RTF is decoded by a dependency-free single-pass parser (font/color/metadata destinations skipped, unicode and hex escapes decoded, embedded binary runs jumped) built to the same linear-time-on-hostile-input standard as the Office extractor.
- **Canvas files are indexed too** (same opt-in setting): the text cards, group labels, and edge labels of `.canvas` boards — previously invisible to search — are extracted in reading order (pure JSON parsing, zero dependencies) and become searchable and readable like any note.
- **`get_note_context` outline mode** (`outline: true`): a headings-only map of a note — line range + full heading breadcrumb per passage, no body. A typical outline is a few hundred characters versus a 12,000-character full read, so the agent can map a note cheaply and then make one targeted ranged read.
- **Queries now match note filenames, frontmatter aliases, and ancestor headings.** Plain BM25 scored only chunk body text, so a query for "Quartzine Protocol" never ranked `Quartzine Protocol.md` unless the body repeated those words, and `aliases` were indexed but never used by ranking at all. A term found only in these fields is credited at the score of one occurrence in an average-length body — enough for a name match to rank, not enough to beat a stronger body match.
- **A golden-query relevance eval harness** (`npm run eval`, local-only like the scale bench): planted invented-term needle notes, recall@8 + MRR per query class (body / filename / heading / alias / plural / phrase). Measured before/after for this release: filename and alias recall@8 went **0.00 → 1.00**; it also showed heading-only and plural/phrase queries were already near-ceiling (so stemming and proximity bonuses were deliberately *not* added).

### Fixed

- **Frontmatter-only notes (alias/link-hub notes) are now findable.** A note holding only frontmatter — aliases and tags, no body — produced zero chunks, so it was invisible to retrieval and its aliases could never match. Such notes now index one stub chunk naming the note and its aliases; truly empty notes stay unindexed.
- **A single malformed character reference no longer discards an entire Office/OpenDocument attachment.** An out-of-range numeric XML reference (e.g. `&#x110000;`) made `String.fromCodePoint` throw `RangeError`, which unwound through the extractor and nulled the whole document (then cached that null). Out-of-range references now degrade to the Unicode replacement character, matching the guard the RTF extractor already applied to `\uN` escapes — the rest of the document is extracted normally.
- **Hardened the RTF `\uc` fallback count against runaway text loss.** A crafted or buggy `\ucN` with an absurd value set the ANSI-fallback swallow count unbounded, so subsequent `\uN` escapes ate the remaining body text and the attachment indexed as empty; the count is now capped like every other untrusted quantity in the walker. Separately, a `\uN` escape ending a group left a pending fallback that could swallow the first character of the *parent* group — group boundaries now clear it.
- **A re-worded restatement of a pending memory no longer lands in the review inbox twice.** Inbox de-duplication compared proposal content byte-for-byte, but an agent re-proposing a fact across sessions rarely reproduces its own wording exactly — it re-wraps a line, indents differently, or varies capitalization — so each restatement became another entry for the reviewer to recognize as the same fact. Content is now compared with whitespace collapsed and case folded. This stays an **exact** comparison of the words themselves: a proposal that adds genuine detail is still a distinct memory and is kept, because suppressing it would lose information permanently, while a duplicate only costs one dismissal.
- **Extractor fixes now reach already-cached attachments.** The extraction cache is keyed on path + mtime, so a corrected extractor would otherwise keep returning a stale (or negatively-cached) result for an unchanged file; the cache version is bumped, discarding prior entries so every attachment is re-extracted once with the fixed logic.
- **…and now reach already-indexed chunks too.** A pre-release audit found the bump above only rebuilt the *cache*: the re-extracted text then hit the index's mtime short-circuit (the file itself is unchanged) and the old chunks kept being served. A discarded extraction cache now forces the affected attachments past that short-circuit once, so corrected text actually lands in search results.
- **Link extraction can no longer freeze the app on hostile input.** The wikilink/markdown-link scans used regexes that backtrack quadratically on `[` floods — ~13 s of main-thread freeze from 100 KB of `[` bytes, and with attachment indexing on, a crafted `.txt`/`.csv`/document re-triggered it on **every** refresh. Both scans are now single-pass linear walkers (measured: 2 MB of hostile input in milliseconds) with identical link extraction on real notes.
- **Attachment file extensions no longer act as search terms.** The filename field-matching credited `report.pdf` with the term "pdf" — a term that appears in almost no note body, so it carried maximum rarity weight and every chunk of every PDF drowned genuine matches for any query containing "pdf". The extension is now stripped (the basename still matches).

### Security

- **Office archives are bounded in aggregate, not just per entry.** The ZIP reader capped each entry at 64 MB inflated, but a crafted archive could spread its payload across hundreds of near-cap entries (the format allows 65535) and decompress tens of GB in total. All entries read from one archive now share a 256 MB inflate budget, and slide/worksheet loops stop at 500 parts (matching the PDF extractor's page cap) — far beyond any real document.

### Changed

- **Truncated reads now say exactly where to continue.** A truncated `get_note_context` names the `startLine` to resume from and the note's full span (previously: generic "narrow with startLine/endLine" advice, whose cheapest recovery was re-reading everything already received). The bulk context reads (`get_project_context`, `get_global_context`, `get_recent_sessions`) now label every file with its vault path, clip at file boundaries, and **name the omitted files** — previously a clipped project context silently dropped the tail files (tasks, open questions) with no trace, a genuine recall hole, and the agent never learned the paths needed for targeted follow-up reads.
- **Heading breadcrumbs now include the section's own heading.** `headingPath` stores ancestors only, so search results and note reads labeled a nested section by its ancestors alone ("Doc" instead of "Doc › Alpha"); the most specific level — usually the most informative one — was dropped.
- **Full-note reads no longer resend the chunker's window overlap or repeat section headings.** Long sections index as overlapping windows (~150 carried characters each, plus the heading line per window); `get_note_context` rendered each window verbatim, resending ~12% of every long section. Consecutive windows of one section now merge under a single heading label with the carry stripped — the strip removes a prefix only when the previous window's text verifiably ends with it, so nothing unseen is ever dropped, and the text now agrees with the advertised line ranges (the carry was never part of a window's span). Outlines likewise show one line per section instead of one per window.

### Performance

- **Filtered (folder/tag/project-scoped) searches are ~8× faster** (p50 162 → 21 ms at 19k chunks — measured by a new filtered-query section in `npm run bench`): per-chunk statistics (term frequencies, lengths, heading/field terms) are corpus-independent and now memoized by chunk identity, surviving any filter; repeated same-filter queries additionally reuse the whole subset's statistics. Unfiltered queries and ranking behavior are unchanged.
- **Lexical queries are ~25% faster** (p50 21 → 15 ms at 19k chunks; hybrid 38 → 31 ms): per-term IDF is now computed once per query instead of per (chunk, term) pair, and the matched-terms array is built only for the page's survivors instead of allocated for every scoring chunk. Behavior-identical — same scores, same order, same matched terms.

## [0.5.0] — 2026-07-07

Milestone 9 — a new name and catalog readiness. The plugin is now **Coder Engram** (breaking for manual installs: the plugin folder id changed; vault data is untouched and old inbox blocks still parse). A compliance pass aligns the plugin with Obsidian's current community-catalog guidelines, and a settings/UI correctness bundle fixes real bugs a UI review surfaced — including per-keystroke server restarts and half-typed tokens being enforced live by server auth. No settings-schema changes; the upgrade is in place apart from the folder rename.

### Added

- **Search results in the desktop UI now show the note's modified date** next to the line range (`Lines 5–8 · 2026-07-05`) — the same staleness signal the MCP output already carries.

### Changed

- **The plugin is now Coder Engram (`coder-engram`).** Renamed from Claude Code Engram ahead of the community-catalog submission (plugin ids are immutable once listed, and the old name leaned on a third-party trademark). The GitHub repository moved to `nfoav8or/coder-engram` (old URLs redirect). **Breaking for existing manual installs:** the plugin folder is now `.obsidian/plugins/coder-engram/` — reinstall under the new id (or rename the folder) and re-enable; your vault data is untouched (the memory root is still `Claude Code/` by default, and pending-inbox blocks written under the old name still parse — the legacy `#claude-code-engram` tag is recognized and stripped).
- **Community-catalog compliance pass** against Obsidian's current plugin guidelines and developer policies: command names and modal titles use sentence case; modals use `setTitle()` and settings sections use `Setting.setHeading()` instead of raw heading elements (the plugin-name heading in settings is gone); the last hardcoded styles moved to a CSS class (`engram-full-width`) so themes can override; the manifest description now opens with an action statement and `authorUrl` points at the author, not the plugin repo; the README gained an explicit **Network use** disclosure (no connections by default; opt-in embeddings and the localhost server described with what is sent where, and a no-telemetry statement).

### Fixed

- **Editing settings no longer restarts the world on every keystroke.** The settings tab committed on every input event, and each commit unconditionally rebound the local server (killing in-flight MCP requests and popping a "listening" Notice per keystroke) — typing a token restarted the server once per character, and typing a memory root reloaded the index from each half-typed prefix. Text fields now commit once, when the field loses focus (or the tab closes); the server additionally skips the rebind entirely when its config is unchanged (non-server settings changes still reach running requests), and the "listening"/"stopped" Notices fire only on real state transitions. The server now also authenticates against a settings **snapshot taken at start** — a half-typed token in the settings tab was previously enforced live, request by request, before the user finished typing it. "Restart Local Server" (command and control-panel button) deliberately bypasses the unchanged-config skip: it remains a real rebind, the recovery lever for a wedged server.
- **Reindex is guarded against double-invocation** (Reindex button/command and the settings tab's "Rebuild now" share one in-flight guard; concurrent invocations no longer run two full scans).
- **Stale search results can no longer overwrite fresh ones in the search modal.** In vector/hybrid mode a search awaits a network embed, so a slow older query could resolve after a newer one; superseded searches are now dropped.
- **Two silent failure paths now surface a Notice** (Show Project Context and End Session Note swallowed I/O errors as unhandled rejections).
- **Changing the indexing exclusions now takes effect on its own.** Adding an excluded folder/tag/pattern (or narrowing the included folders) previously left already-indexed notes searchable — and their vectors cached — until a manual reindex or an unrelated vault event happened to fire a refresh. `updateSettings` now reports `scanConfigChanged` and the plugin schedules a debounced refresh in response, gated only on `indexingEnabled` (not on `autoIndexOnChange`, which governs continuous file-event indexing). Follows the 0.4.0 audit's recommendation.

## [0.4.0] — 2026-07-06

Milestone 8 — a sharper, safer, cheaper agent loop. Search hands the agent line-ranged, dated, de-duplicated results; `get_note_context` can read exactly the region a hit points at; unreviewed inbox proposals are labelled so they never masquerade as accepted memory; the session-priming tools are output-bounded and rate-limited; and indexing no longer reads unchanged files or rewrites unchanged indexes — closing a self-sustaining refresh cycle. One real bug fixed: embedding-provider changes in the settings tab now apply without a plugin reload. Every security invariant re-audited across the full delta (clean, 0 npm vulnerabilities); no settings/schema changes — an in-place upgrade from 0.3.0.

### Added

- **`get_note_context` accepts `startLine`/`endLine`** (1-based, matching the line ranges search results carry): only passages overlapping that span are returned. This fixes a dead-end in the agent loop — the tool previously assembled passages from the top of the note and hard-stopped at `maxChars`, so a search hit deep in a long note was unreachable by its own "natural follow-up". Pass the hit's line range to read exactly that region. A range matching no indexed passage reports the note's actual indexed span; the indexed-only gate is unchanged and checked first.

### Fixed

- **Switching the embedding provider/model/endpoint/key in the settings tab now takes effect without a plugin reload.** The engine decided "did the embedding settings change?" by comparing against its held settings object — but the settings tab mutates that same object in place, so the engine compared the object to itself and the provider/retriever rebuild never fired on the real settings path (it worked in tests, which pass fresh objects). The engine now snapshots the embedding-settings identity as its own string state. The re-embed trigger and the rebuild are also now driven by one definition owned by the engine (`updateSettings` returns `{ rootChanged, embeddingChanged }`), removing a duplicated signature in the UI layer that could drift.

### Changed

- **The bulk context reads are now bounded and rate-limited.** `get_project_context`, `get_global_context`, and `get_recent_sessions` — the session-priming tools — previously returned unbounded concatenations of whole memory files (and up to 20 full session notes) with no rate limit, so they grew into the loop's biggest token sink as a vault matured. They now accept `maxChars` (default 12000, max 50000), truncate past it with a pointer to targeted recall (`search_vault_memory` + `get_note_context`), and carry a 60/min sliding-window cap like the other read tools.
- **Search results carry the note's modified date** (`YYYY-MM-DD`, in the result header next to the line range). `sinceDays` filtering already existed, but the agent couldn't see *which* hit was from yesterday versus two years ago — which is what matters when memories conflict. Display-only: a deliberate, recall-safe alternative to recency-*ranking*, which would change scoring semantics. MCP output only.
- **Search hits from the review inbox are labelled `[PENDING REVIEW — proposed, not yet accepted]`.** The inbox is ordinary vault Markdown, so after a reindex an agent's own unreviewed proposal is searchable — previously it came back indistinguishable from accepted memory, quietly bypassing the human review on the read side. The label closes that self-reinforcement loop while keeping the content searchable (an agent can still see that — and what — it already proposed). MCP output only.
- **`search_vault_memory` returns leaner, higher-signal results to Claude Code.** Near-duplicate hits are collapsed (token-set overlap ≥ 0.8), so the agent isn't fed — or charged tokens for — the same memory twice (e.g. a decision copied into a session note); the dropped copy still survives in the higher-ranked result, so recall is unaffected. Dropped duplicates no longer shrink the page: the tool fetches a deeper candidate pool (2× the requested limit) and backfills with the next distinct results, re-applying the per-note diversity cap at the final page size — so `limit` now means "up to this many *distinct* memories". Each result now carries its **line range** and drops the low-signal score float — every returned token should aid recall. The tool description no longer claims "lexical BM25" only; it reflects the configured retrieval mode (lexical by default, vector/hybrid when an embedding provider is set). This affects the MCP output only; the desktop search UI is unchanged.

### Performance

- **A refresh now reads only changed notes from disk.** The vault scanner read the full content of every eligible note on every debounced refresh (the mtime short-circuit happened after the read), so "incremental" held for chunking but not for file I/O — every vault event re-read the whole vault. The engine now passes the index's known per-note mtimes into the scan, which skips unchanged files without touching disk (re-scan at 2k notes: ~60 ms → ~2 ms in-memory; on a real vault the saving is actual disk I/O). Safety: the fast path is invalidated whenever the scan config changes, so adding an excluded tag/folder still re-checks every note on the next refresh — an exclusion is enforced by verdict, never assumed from a stale scan.
- **A zero-change refresh is now actually free.** Previously every debounced auto-refresh (a) re-serialized and rewrote the whole `Index/chunks.json` + `metadata.json` on the main thread even when nothing changed — and because those files live inside the vault, the plugin's own writes re-fired the vault watcher and scheduled the next refresh, sustaining a permanent refresh/serialize/write cycle with auto-indexing on; and (b) swapped in a new (equal-content) chunks array, silently invalidating the memoized BM25 corpus stats so the next query re-paid the full stats build. Now: a no-op refresh skips the persist entirely, keeps the chunks-array identity (the stats memo survives), skips the retriever rebuild when the embedding pass changed nothing, and the file watcher ignores the plugin's own `Index/`/`Config/` writes altogether.

## [0.3.0] — 2026-07-05

Milestone 7 — a deeper, safer Claude Code memory loop. New MCP tools to read a search hit's full passage and navigate the link graph, `add_memory` de-duplication so a looping agent can't flood the review inbox, and a persistence optimization — all on top of the safety-first model: agent writes still land in the review inbox, and nothing is written or edited without your approval. No settings/schema changes; an in-place upgrade from 0.2.0.

### Added

- New MCP tool **`get_note_context`**: returns the full **indexed** text of a single note, passage by passage, each labelled with its heading and line range — the natural follow-up to a `search_vault_memory` hit, which only returns a short snippet. Inputs: `path` (required) and `maxChars` (optional, default 12000, max 50000; the note is truncated past this). Rate-limited (60/min).
- New MCP tool **`find_related_notes`**: navigates the memory graph from one **indexed** note — returns the indexed notes it links to and the indexed notes that link back to it. Links resolve by note name (Obsidian-style, basename); only indexed notes appear and an excluded/unindexed note is refused. Input: `path` (required). Rate-limited (120/min).

### Changed

- **`add_memory` now de-duplicates.** Proposing a memory whose content, type, and project match an entry already pending in the review inbox no longer appends a second copy — so a looping or re-running agent can't flood the inbox with identical proposals. The MCP tool reports `already pending … not added again` (and the UI shows `Already pending …`) so the caller knows it was a duplicate. The check runs inside the existing inbox mutex, so it can't interleave with a concurrent propose/apply/discard.

### Performance

- The embeddings cache (`Index/embeddings.json`) is no longer re-serialized and rewritten when an index refresh changed nothing — a no-op refresh (all vectors reused, none removed, identity unchanged) now skips the write entirely. Previously every refresh rewrote the whole file (tens–hundreds of MB at scale) on the main thread, even when the output was byte-identical.

### Security

- `get_note_context` reuses the same **in-scope-only** gate as `summarize_note`: it reads only notes that are in the index, so an excluded or unindexed note has no chunks and is refused. It exposes no data that `search_vault_memory` did not already surface from the same indexed corpus, adds no generic file-read or full-vault dump, and remains behind the server's existing localhost + token + DNS-rebinding gating.

## [0.2.0] — 2026-07-04

Milestone 6 — retrieval quality. A focused round of relevance, navigation, and performance improvements on top of the 0.1.0 RAG core. No settings or schema changes, no new network egress, and no breaking changes: an in-place upgrade. See [docs/RAG_PIPELINE.md](docs/RAG_PIPELINE.md).

### Added

- **Precise per-chunk line spans.** The chunker now records the exact original-line span each window covers (rather than every window sharing its section's span). Search results display the line range (e.g. "Lines 5–8"), and clicking a result opens the note with the cursor on the chunk's start line instead of the file top.
- **Per-note result diversity.** A single long note can no longer flood the result page: at most `ceil(limit/3)` (floor 2) chunks per note are shown, with rank-order backfill so the page is never shorter than a plain top-`limit` and a query matching only one note still fills from it.
- **Developer test harnesses (not shipped in the plugin):** a Playwright end-to-end UI smoke test that drives the real plugin inside real Obsidian (`npm run test:e2e`), and an on-demand retrieval scale benchmark over a large synthetic vault (`npm run bench`). Both are local-only and excluded from `npm test`/CI.

### Changed

- **Snippets and highlighting.** Snippets now select the window covering the *most* query-term matches (densest context) rather than centering on the first match, and both snippets and UI `<mark>` highlighting use whole-token matching so a query term like `art` matches the word but not the `art` inside `restart`.

### Performance

- **BM25 corpus statistics are memoized.** Per-chunk term frequencies, document frequencies, average document length, and per-chunk heading tokens were previously recomputed from scratch on every query. They are now computed once and cached by the chunk-set identity (invalidated on reindex), cutting lexical query latency ~7× and hybrid ~5× on a large vault (≈157 ms → 21 ms lexical, ≈174 ms → 37 ms hybrid at ~19k chunks). Behavior is unchanged.
- Snippet building is deferred until after the result limit is applied, and chunk tokenization is memoized by chunk identity, so broad queries no longer build snippets or re-tokenize for chunks that get discarded.

### Removed

- Dead code: `parentPath`, `ProjectMemory.projectExists`, `Debounced.flush`, and the unused `RetrievalError` / `AuthError` classes. Also fixed a stray NUL byte in `engine.ts` that made the file read as binary to text tools.

### Security

- The retrieval changes are pure in-memory result-shaping over already-filtered, already-scored chunks — no path, write, network, or authentication surface is touched, so all six security invariants (in-vault writes only, inbox-first, localhost/token/DNS-rebinding server gating, UI-only promotion, opt-in embeddings, safe settings migration) are unchanged. Excluded/sensitive notes remain unindexed and therefore never scored, snippeted, or embedded.

## [0.1.0] — 2026-07-03

First tagged release of Coder Engram — a local-first memory + RAG layer for Claude Code, storing memory as Markdown inside your Obsidian vault. It comprises Milestones 1–5, detailed below: the memory + lexical RAG core (M1), the local MCP/HTTP server (M2), embedding providers with vector + hybrid retrieval (M3), the pending-memory review UI plus extractive `summarize_note` (M4), and CI + release packaging (M5). See [docs/ROADMAP.md](docs/ROADMAP.md).

## Milestone 5 — CI + release/packaging

### Added

- GitHub Actions **CI** (`.github/workflows/ci.yml`): typecheck, lint, test, and build on every push to `main`/`develop` and every pull request, with a read-only token.
- GitHub Actions **Release** (`.github/workflows/release.yml`): on a version-tag push it gates on a green typecheck/lint/test/build, verifies the tag matches `manifest.json` (a leading `v` is tolerated), and publishes `main.js`, `manifest.json`, and `styles.css` to a GitHub Release via the runner's `gh` CLI.
- Version tooling (`version-bump.mjs` plus an `npm version` script) that keeps `manifest.json` and `versions.json` in sync with `package.json`.

### Security

- The release workflow is least-privilege (`contents: write` only), uses the built-in `GITHUB_TOKEN` and the runner's `gh` CLI with no third-party publish actions, has no `pull_request_target`, and grants fork pull requests only a read-only token. No secrets are written into build artifacts.

## Milestone 4 — Review UI + extractive summarize_note

A richer review UI for the pending-memory inbox and an honest, extractive `summarize_note`. Both build on existing layers; no new network egress and no generative backend are introduced.

### Added

- Pending-inbox parser/serializer (`src/memory/pending-inbox.ts`): the single producer of the on-disk pending-block format. `MemoryWriter.formatMemoryEntry` delegates to its `renderPendingBlock`, so the inbox round-trips (parse ⇄ render).
- Rewritten **Review Pending Memory** modal (`src/ui/pending-memory-modal.ts`): each pending entry is a card showing its resolved destination with per-entry **Apply**, **Edit & apply**, and **Discard** controls. The previous raw-file "Open inbox file" escape hatch remains.
- New `MemoryWriter.readInbox()`, `applyPending(entry)`, `discardPending(entry)` and engine `getPendingMemory()`, `applyPendingMemory(entry)`, `discardPendingMemory(entry)`. Apply **promotes** a reviewed entry by appending it into the destination memory file resolved by type/project (`resolveApplyDestination`) — project entries into that project's architecture/decisions/tasks/open-questions/overview file; global entries into `Global/preferences.md` (preference), `Global/conventions.md` (decision/architecture/task/…), or `Global/profile.md` (note/other) — then removes it from the inbox.
- Extractive `summarize_note` (`src/summarize/extractive.ts`): sentence splitting plus two ranking backends over one selection routine — lexical frequency-centrality (Luhn/centroid, always available offline) and, when an embedding provider is configured and reachable, embedding-centroid similarity with Maximal Marginal Relevance (MMR) to drop redundant near-duplicate sentences. A summary is a selection of the note's **own** sentences, returned verbatim in original order — there is no LLM/generative backend.
- New engine `summarizeNote(path, {maxSentences})` and `getNoteChunks(path)`, MCP tool `summarize_note` (default 5 sentences, max 20; rate-limited 30/min), and a new **Summarize Current Note** command.

### Security

- Apply/promotion is the human-in-the-loop counterpart to inbox-first writes, so it is intentionally **not** gated behind `allowDirectWrites` (which governs unattended/tool direct writes). It is reachable only from the desktop review UI — the local server never exposes an apply/promotion tool. It stays constrained: the destination is validated inside the memory root (`isInsideRoot`), and the write is **always** an append — it never overwrites an existing memory file, regardless of the `appendOnly` setting.
- `summarize_note` is in-scope only: it summarizes solely notes that are in the index. An excluded/unindexed note has no chunks and is refused, so a summary can never become a side channel that surfaces a note the exclusion filters were meant to keep out.
- `summarize_note` embedding is fail-open — a provider error degrades to lexical selection rather than hard-failing — and the note's sentence-units are capped (200) so one huge note cannot fan out into an unbounded embedding request.

## Milestone 3

Real embedding providers and vector + hybrid retrieval. Vector search is opt-in: the embedding provider defaults to `none`, so retrieval stays lexical and fully offline until a provider is configured. See [docs/ROADMAP.md](docs/ROADMAP.md).

### Added

- Embedding providers behind the existing `EmbeddingProvider` interface: `OllamaEmbeddingProvider` (local Ollama, batch `POST /api/embed`, no API key) and `OpenAiEmbeddingProvider` (any OpenAI-compatible `/embeddings` endpoint, `Authorization: Bearer` auth, response sorted by `index` to preserve order). A `createEmbeddingProvider` factory returns `null` — falling back to lexical — whenever required config is missing, and never throws.
- `HttpClient` boundary (`src/core/http-client.ts`) for all outbound client HTTP, with the production `ObsidianHttpClient` wrapping Obsidian's `requestUrl` (CORS-free). Providers depend only on the interface and are unit-tested with a `FakeHttpClient`; `ObsidianHttpClient` is now the second (and only other) file allowed to import `obsidian`, alongside `ObsidianVaultAdapter`.
- `EmbeddingStore` (`Index/embeddings.json`, schema `{version, model, dim, vectors}`): embeds at index time, reuses vectors whose content hash is unchanged, drops removed chunks, and recomputes everything when the backend identity changes. The identity encodes provider + model + a hash of the endpoint + a hash of the API key (secrets are hashed, never stored), so an endpoint or key swap correctly invalidates the cache. Embedding passes are single-flighted so overlapping reindex/refresh/sync cannot interleave or clobber the persisted cache. Writes go through the `VaultAdapter`, so vectors stay inside the vault.
- `VectorRetriever` (cosine similarity) and `HybridRetriever` (Reciprocal Rank Fusion, k=60, of lexical + vector) behind the existing `Retriever` interface.
- New settings: `retrievalMode` (`lexical` | `hybrid` | `vector`, default `hybrid`), `embeddingEndpoint`, `embeddingApiKey`, and `embeddingBatchSize` (default 16, clamped 1–512). Settings schema bumped v2 → v3 with a safe-default migration. Settings UI adds provider-conditional model / endpoint / API-key (password) / batch-size fields and a retrieval-mode dropdown.
- `EngramEngine.search` is now async: vector/hybrid modes embed the query first (`RetrievalQuery` gained an optional `queryVector`), while lexical mode resolves without any network call. Embedding runs at reindex/refresh time, batched by `embeddingBatchSize`.

### Security

- The embedding API key is a secret: stored locally, sent only in the `Authorization` header, and never logged (the debug logger's secret-key redaction already covers `apikey`/`api_key`).
- The OpenAI-compatible provider transmits indexed note text to a possibly-remote endpoint — a genuine data-egress consideration. It is explicit opt-in; the provider defaults to `none`, and the settings UI shows a notice on selection. Excluded/sensitive notes are never indexed, so they are never embedded or sent.
- A missing or unreachable provider degrades to lexical retrieval (fails open to offline search); vectors are never faked and a vector backend is never on the critical path.
- Outbound embedding requests enforce a timeout (`ObsidianHttpClient` races `requestUrl` against a rejecting timer, since `requestUrl` cannot be aborted), so a stalled or black-holed endpoint can never hang search or block indexing.
- Query-time identity guard: the engine only scores a query against cached vectors when their backend identity matches the active provider. After a same-dimension model/endpoint swap (or a stale-on-disk restart) it degrades to lexical rather than returning plausible-but-wrong rankings, until a re-embed catches up.
- The OpenAI-compatible provider validates that server-supplied `index` values form a proper `0..n-1` permutation before mapping vectors to chunks, so a malformed response cannot silently misattribute an embedding.
- Cached embeddings are written only inside the vault, under `Index/embeddings.json`, through the same `VaultAdapter` choke-point as the rest of the index.

## Milestone 2

Local MCP/HTTP server for Claude Code. The server is disabled by default and binds to `127.0.0.1`.

### Added

- Local MCP/HTTP server (`src/server/`) speaking JSON-RPC 2.0 MCP: `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. `local-server.ts` is the only file that touches `node:http`; auth, host/origin guards, protocol dispatch, and the tool registry live in separate, unit-tested modules (`auth.ts`, `net.ts`, `mcp-protocol.ts`, `mcp-tools.ts`).
- Server tools: `search_vault_memory`, `add_memory` (always inbox-first over the network), `get_project_context`, `get_global_context`, `list_projects`, `get_recent_sessions`, and `reindex_vault` (rate-limited with a 15s cooldown).
- New setting `server.allowNonLocalhost` (settings schema bumped to v2, with a safe-default migration): the server refuses to bind a non-localhost host unless this is enabled **and** a token is set.
- New command **Restart Local Server**; server start/stop is wired into `onload`/`onunload` and reconciled on settings changes. The control panel shows live server status (`running · host:port`).
- 67 additional Vitest tests covering token auth, host/origin guards, the tool registry and rate limiter, JSON-RPC dispatch, batch limits, and lifecycle serialization.

### Security

- Constant-time bearer-token authentication (SHA-256 digest + `timingSafeEqual`); tokens are never logged.
- DNS-rebinding protection: the `Host` header is validated against the bound address and any non-loopback `Origin` is rejected. Only a genuinely absent `Origin` passes; opaque origins (`Origin: null`) are rejected.
- Request hardening: POST-only, `Content-Type: application/json` required, a 1 MB request-body cap (413 on overflow), and a 32-message cap on JSON-RPC batches (400).
- Writes over the network are inbox-first by construction — the server never performs direct writes even when `allowDirectWrites` is enabled, and exposes no generic file access or full-vault dump.
- JSON-RPC parse and validation errors are returned as structured errors. `reindex_vault` has a 15s cooldown; `search_vault_memory` and `add_memory` have per-minute sliding-window rate limits.
- Server start/stop/restart is single-flighted so overlapping settings changes cannot bind two listeners or leak a port.

### Notes

- `summarize_note` was intentionally not implemented: honest summarization needs an LLM/embedding backend and is deferred to M3+.

## Milestone 1

First working local memory + lexical RAG layer.

### Added

- Obsidian plugin scaffold: entrypoint, manifest, settings tab, and right-sidebar control panel (with ribbon icon).
- Ten command-palette commands: Open Control Panel, Reindex Vault, Search Memory, Add Memory, Add Current Note to Project Memory, Create Project Memory Folder, Show Project Context, Review Pending Memory, Start Session Note, End Session Note.
- Safe path handling: a single `resolveInVault` choke-point that normalizes vault-relative paths and rejects absolute paths and `..` traversal.
- Configurable memory root (default `Claude Code`), validated to stay inside the vault.
- Vault scanner with included/excluded folders, excluded tags, and excluded path patterns (glob or substring).
- Heading-aware, code-fence-aware Markdown chunker that windows long sections with overlap.
- Metadata extraction (frontmatter tags/aliases/title, inline tags, wikilinks, relative Markdown links) with no YAML dependency.
- Local JSON index (`chunks.json`, `metadata.json`, `embeddings.json`) with full build, incremental mtime-based refresh, atomic persist, and load-or-rebuild.
- BM25 lexical retrieval with a heading-match boost and folder/tag/project/recency filters.
- Retriever interface so a vector retriever can slot in later without changing callers.
- `EmbeddingProvider` interface plus a deterministic mock (hash-based) provider for development and tests. No real vector retrieval yet.
- Memory model and folder scaffolding: global files (profile, preferences, conventions), per-project files, and timestamped session notes.
- Memory writer with an append-only review inbox (`pending-memory.md`) as the default write path, and double-gated direct writes.
- Settings with safe defaults (indexing on, server off, direct writes off, append-only on, debug logging off) and non-throwing settings migration.
- Debug-gated logger that redacts secrets.
- `VaultAdapter` boundary with an in-memory implementation for tests.
- Vitest test suite: chunking, metadata extraction, index build/refresh, lexical retrieval, path safety and traversal rejection, settings defaults, memory model, and memory writes.

### Security

- Local server disabled by default; binds to `127.0.0.1` when enabled (server implementation lands in M2).
- Direct memory writes disabled by default; append-only enabled by default.
- No cloud services or API keys required for the default experience.

[Unreleased]: https://github.com/nfoav8or/coder-engram/compare/0.8.0...HEAD
[0.8.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.8.0
[0.7.1]: https://github.com/nfoav8or/coder-engram/releases/tag/0.7.1
[0.7.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.7.0
[0.6.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.6.0
[0.5.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.5.0
[0.4.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.4.0
[0.3.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.3.0
[0.2.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.2.0
[0.1.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.1.0
