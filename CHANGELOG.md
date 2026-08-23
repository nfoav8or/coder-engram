# Changelog

All notable changes to Coder Engram are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.7] — 2026-08-22

### Performance

- `embeddings.json` moves to a version-2 format: vectors are stored as base64
  Float32Array bytes with a precomputed norm, ~40% smaller on disk, far cheaper
  to parse at load, and half the heap per component. A version-1 file is
  migrated in place at load — upgrading never re-embeds.
- Lexical retrieval gains an inverted index: per-term posting lists (body +
  field terms) bound each query by its matching chunks instead of a full-corpus
  scan. At 10k synthetic notes, filtered lexical p50 dropped ~27%.
- Vector scoring reads each stored vector's norm from the store instead of
  recomputing or session-caching it.

### Added

- The embedding pass checkpoints every ~1,024 newly embedded chunks, so a long
  first pass interrupted by an Obsidian quit resumes from the checkpoint
  instead of restarting from zero.
- New **Concurrent batches** setting (`embeddingConcurrency`, default 1,
  clamped 1–8): embedding batches in flight at once. The default stays
  strictly sequential so rate-limited hosted APIs are never flooded; 2–4
  roughly doubles first-pass throughput against a local Ollama.

## [0.10.6] — 2026-08-19

### Fixed

- `migrateSettings` now coerces a non-string `server.token` (from a corrupt or
  hand-edited settings blob) to the safe empty default instead of letting it
  flow through and throw at server startup — restoring the documented
  "corrupt blob degrades without throwing" invariant.
- A pending-memory `content` whose last paragraph is byte-identical to a real
  `Related files:` section (when the entry has no real one) is no longer
  silently split at parse time — the tail stayed in `content` instead of being
  presented as related-path metadata. `renderPendingBlock` now neutralizes
  exactly that ambiguous tail (one leading space, the same mechanism as
  heading neutralization); every other placement of the phrase is preserved
  verbatim, and round-trips stay byte-stable.

### Performance

- Vector/hybrid queries no longer recompute both vector norms per candidate:
  the query's norm is computed once per query and each stored vector's norm is
  memoized for the vector's lifetime, leaving only the dot product per
  candidate (~3× fewer FLOPs on the scoring loop).
- An embedding pass triggered by an edit re-hashes only the changed notes'
  chunks: content hashes are memoized by chunk object identity, and the engine
  now hands the store the real chunk objects instead of per-call wrappers
  (previously every pass re-hashed the full corpus text).
- `getNoteChunks` — behind `summarize_note`, `get_note_context`, and
  `find_related_notes` — is an O(1) memoized per-note lookup instead of an
  O(corpus) scan per request, using the same chunks-array-identity contract as
  the link-graph and corpus-stats caches.

### Security

- CI and release workflows pin all third-party GitHub Actions to full commit
  SHAs (with version comments) instead of mutable major-version tags, closing
  the moved-tag supply-chain vector against a workflow that holds release,
  OIDC, and attestation permissions.

### Changed

- Removed two test-only convenience exports (`lexicalSearch`,
  `matchesPathPattern`); their tests now exercise the public API directly.
  `toEmbeddingConfig` reuses the `EmbeddingConfig` interface instead of
  duplicating its shape inline.

## [0.10.5] — 2026-08-16

### Fixed

- **`summarize_note`'s lexical ranking now works in any script.** The
  extractive summarizer kept its own copy of the ASCII-only word pattern that
  0.10.4 cured retrieval of, so a note in Russian, Greek, Hebrew or CJK
  produced zero tokens, every sentence scored 0, and "most representative
  sentences" silently degraded to the first N in document order. Letters and
  numbers in any script now tokenize (apostrophes and hyphens still stay inside
  a token, as before), and composed vs decomposed spellings of the same word
  now count as one word.

### Performance

- **An all-unchanged refresh skips the embedding pass.** The pass re-hashes
  every chunk in the corpus to find work, even when the refresh already proved
  there is none — O(vault) synchronous work on the majority of debounced
  refreshes when a provider is configured. It now runs only when the refresh
  changed something or the embedding backend identity changed since the last
  completed pass.
- **Vault scans fold each include/exclude rule once, not once per file.**
  Folder normalization, case/Unicode folding, and glob compilation were
  recomputed for every file × every rule on every scan (~10^5 redundant NFC
  normalizations per debounced refresh at 10k notes). Eligibility is now
  compiled once per scan and each path folded once.
- **`find_related_notes` reuses the link graph across calls.** The graph was
  rebuilt from every chunk on every request; it is now cached keyed on
  chunks-array identity — the same invalidation contract the lexical
  corpus-stats memo uses — so a rebuild is paid once per index change, and each
  request resolves from the note's own links.

## [0.10.4] — 2026-08-13

Two fixes for the same blind spot: the plugin assumed text was ASCII. One of
them is a privacy filter that was failing open, so this release forces a single
index rebuild on first load.

### Security

- **An excluded tag written in any script now actually excludes.** Inline
  `#tags` were recognized with an ASCII-only pattern, so `#privé` was read as
  the tag `priv` and `#личное` as no tag at all. Tag exclusion is how you keep a
  note away from the agent — and because the tag the parser saw was not the tag
  you excluded, the filter failed open: the note was indexed and reachable over
  the local server. Frontmatter tags were never affected, which is why the
  earlier Unicode-form fix in 0.9.9 did not reveal this. Fixing the parser alone
  would have left those notes sitting in your existing index, so this release
  rebuilds the index once on first load to drop them — expect one reindex.

### Fixed

- **Notes that are not in English are searchable.** Lexical search split words on
  anything outside `a-z0-9`, which treated every accented or non-Latin character
  as a separator. German "Müller Straße" was indexed as `ller`, `stra`; Russian,
  Greek, Japanese, Chinese and Hebrew notes yielded **no search terms at all**,
  so they could never be found by the offline search that is the default and the
  only mode needing no network. Words are now split on letters and numbers in
  any script. English results are unchanged — the relevance eval scores
  identically before and after. This change needed no reindex of its own
  (search terms are computed per query, never stored), though the security fix
  above triggers one anyway. Scripts written without spaces (CJK) are indexed as
  one term per run rather than per word, which finds an identical query but not
  a substring of one; that limit is now stated in the README.
- **The same word matches whichever encoding it arrived in.** Accented text
  reaches the plugin composed when typed and decomposed when it came from a
  macOS path or filename. The two render identically but produced different
  search terms (`café` became `caf` or `cafe`), so a note could fail to match a
  query that was the same word.
- **The review inbox no longer shows two cards that look identical.** Accented
  text reaches the plugin in two encodings that render the same: decomposed when
  it came from a path or filename read on macOS, composed when typed or pasted.
  Proposal de-duplication compared them as different words, so the same fact
  proposed from both sources opened a second review card with nothing on screen
  to explain why. Both encodings are now normalized before the comparison, which
  cannot suppress a proposal carrying real detail — they are the same
  characters.

## [0.10.3] — 2026-08-13

Four fixes, no new surface and no behaviour change for a healthy vault. Three of them concern
things this plugin writes into your vault and later reads back — index caches and the review
inbox — where the file can be changed between the write and the read by sync, another tool, or
simply by the plugin racing itself.

### Security

- **A failed tool call no longer tells the client where your vault lives.** Tool
  failures are reported in-band so the agent can act on them, which makes the
  message text an output channel. Errors this plugin raises are authored and
  were always safe, but an error raised beneath it — Node's filesystem layer,
  Obsidian's adapter — quotes the vault's absolute path, and with it your
  account name and the vault's real folder name. `add_memory` and
  `reindex_vault` could both surface one. Absolute paths are now stripped
  before the message leaves; the vault-relative path survives, so the client
  still learns which note failed, and the full message still reaches the log.

### Fixed

- **A corrupt index file no longer leaves search broken until you reindex by
  hand.** `Index/chunks.json` lives in your vault, so a sync conflict or another
  tool can leave behind a file that still parses as a JSON array but holds the
  wrong shapes. That loaded as if it were fine, and then every search failed
  with an internal error. The index is a rebuildable cache, so the answer is the
  same one a version mismatch already gets: discard it and rebuild.
- **The same applies to the other two caches under `Index/`.** A damaged
  `embeddings.json` could break every vector search, or score a corrupt vector
  into an arbitrary position in your results rather than being discarded. A
  damaged `extracted.json` could silently switch off the limit on how much
  attachment text one scan may index, and its cached metadata feeds the
  tag-exclusion check — so a malformed entry could have affected which
  attachments were excluded. Both are now validated on load and recomputed when
  they do not hold up.
- **A reviewed memory can no longer come back from the dead.** Discarding or
  applying an entry rewrites the whole review inbox, and those rewrites are
  serialized so two of them cannot clobber each other. That serialization was
  attached to an object the plugin replaces whenever any setting changes, so a
  settings commit landing between two clicks in the review pane left the first
  rewrite unwaited-for — and the entry you had just discarded reappeared. The
  lock now outlives the settings change.

## [0.10.2] — 2026-08-12

### Fixed

- **A port or batch size outside its range is refused again.** The declarative
  settings tab introduced in 0.10.0 lost a guard the previous tab had: `min`
  and `max` on a number field are hints to the input element, not a bound the
  app enforces, so on Obsidian 1.13 and later a value like port `999999` was
  accepted. Nothing broke outright — the server declined to start and the next
  reload rewrote the value to the nearest legal one — but the setting silently
  became something other than what was typed. Both fields now say so inline as
  you type, which is better than the old behaviour of quietly ignoring the
  input.

## [0.10.1] — 2026-08-09

Housekeeping only: nothing about the plugin's behaviour changes. It exists so Obsidian's automated plugin review reports nothing that is not worth reading.

### Changed

- Internal: the resolved Global-memory folder path is now `MemoryPaths.globalDir`
  rather than `MemoryPaths.global`. Obsidian's plugin review reads the bare
  identifier as a reach for Node's `global` object — a false positive on a
  property name, but one that would be reported on every release. No behaviour
  and no stored data change.
- The settings tab is now covered end-to-end in a real Obsidian: six checks
  assert it renders from the declarative definitions rather than the legacy
  path, that the API key field appears for the provider that sends one and for
  neither of the others, that both secrets render masked, and that clicking a
  control writes through to settings.

## [0.10.0] — 2026-08-09

Settings are declarative, so every one of them turns up in Obsidian's settings search — plus the fixes from Obsidian's automated review of 0.9.9.

### Added

- **Settings now appear in Obsidian's settings search** (1.13 and later). The tab
  is described declaratively via `getSettingDefinitions()`; a tab driven only by
  `display()` is absent from that search, which for thirty settings is a real
  thing to lose. Nothing moves and nothing is renamed — the same settings, in
  the same order, now findable by typing.
- Two behaviours the imperative tab could not manage: the memory root is
  rejected **inline as you type** rather than by a notice after the fact, and
  **Index text inside images** is visibly disabled until attachment indexing is
  on, instead of silently doing nothing.

### Changed

- **`minAppVersion` stays 1.7.2.** Obsidian ignores the old `display()` as soon
  as the declarative definitions exist, so 1.13+ renders the new way while older
  apps keep the previous tab, unchanged. Raising the floor would have stranded
  everyone below 1.13.
- Internally the tab became data: `setting-definitions.ts` describes every
  setting and is unit-tested (every setting bound to a control, no two controls
  sharing a key, every key round-tripping through the settings object), where
  the imperative UI it replaces could not be tested at all.

### Fixed

- **Settings are read through this plugin's own interface, not `Plugin`.**
  Obsidian 1.13 added a `settings` property to `Plugin`, and the settings tab
  held its host as `Plugin & SettingsHost` — so reading `settings` resolved to
  Obsidian's, an API that does not exist on the 1.7.2 this plugin declares as
  its minimum. Obsidian's automated review flags it as an error, and it is the
  kind of mistake that only surfaces on an older app.
- The OCR extractor narrows a vault entry with a type predicate instead of
  casting to `TFile`. Structural narrowing is still the right call — `obsidian`
  ships types only, so naming `TFile` in a value position would break the
  Node-environment tests — but a predicate says so in the type system rather
  than asserting past it.
- Dropped a redundant type assertion in `migrateSettings`.
- The ZIP inflate loop no longer accounts for sizes with untyped values.
  `pipeThrough` loses the element type, so the inflated chunks arrived as `any`
  — and that arithmetic is what stands between a crafted archive and an
  unbounded allocation.
- **Releases 0.9.1 through 0.9.9 are now reachable from Obsidian's plugin
  browser.** Obsidian downloads a plugin from a GitHub release tagged
  identically to the version in `manifest.json`, and every 0.9.x release was
  tagged `v0.9.x` instead — `npm version`, the flow this project's own README
  documented, adds that prefix by default. The releases existed and the
  workflow was green, but the URL Obsidian asks for returned 404, so the
  directory listing stayed on the version it had and no update ever arrived.
  Each 0.9.x version has been re-published under its bare tag, `.npmrc` stops
  npm adding the prefix, and the release workflow now rejects a prefixed tag
  rather than tolerating it.

## [0.9.9] — 2026-08-08

One security fix: an exclusion naming an accented folder, tag, or pattern could silently do nothing.

### Fixed

- **An exclusion naming an accented folder, tag, or pattern no longer silently
  does nothing.** macOS stores an accented filename decomposed (`e` plus a
  combining accent) while the same name typed into the settings box arrives
  composed (one codepoint) — one name to a person and to the filesystem, two
  different strings to a comparison. All three filters compared the raw strings,
  so `Privé` typed into excluded folders could match a folder of that exact name
  on disk and leave its notes indexed and readable over the local server, with
  nothing in the UI to say the exclusion had no effect. This is the same
  failure direction that matching case exactly had before 0.9.2, and it is now
  folded the same way. **If you exclude anything with an accent or non-Latin
  script, check it once: an entry that was quietly doing nothing now takes
  effect, and those notes leave the index on the next refresh.**
- An excluded folder written as `./Private` now matches, like every other path
  in the plugin — leading `./` and repeated slashes are dropped rather than
  treated as part of the folder name.

## [0.9.8] — 2026-08-08

One fix: the project list can no longer flood an agent's context.

### Fixed

- **`list_projects` no longer returns an unbounded list.** It was the one read
  tool with no cap on its output, because a list of project names reads as a
  handful of short strings — but the names are not the plugin's to assume short
  (200 characters where an agent supplies one, longer for a folder made by
  hand). Measured, a vault with 1 000 such projects returned 197 KB from a
  single call, roughly 49 000 tokens spent by the tool whose purpose is to save
  them. The list is now clipped at 4 000 characters and says how many projects
  are not shown, so ordinary vaults are unaffected and large ones degrade
  honestly instead of flooding the agent.

## [0.9.7] — 2026-08-08

One fix: the image-text setting takes effect when you toggle it, in both directions.

### Fixed

- Toggling **Index text inside images** now takes effect immediately, in both
  directions. The setting was missing from the set that tells the plugin a
  refresh is needed, so turning it on indexed nothing and — more importantly —
  turning it off left the text already read out of images in the index, still
  searchable over the local server, until some unrelated edit happened to
  trigger a scan. Every other setting that changes what the index should
  contain already scheduled that refresh; this one did not.

## [0.9.6] — 2026-08-08

One fix: the startup optimization from 0.9.5 reaches upgrading users, instead of only new ones.

### Fixed

- **The startup optimization added in 0.9.5 now actually reaches anyone upgrading to it.** It depends on the index recording which scan config its note mtimes were gathered under, and an index written by an earlier version has no such record. The first launch after upgrading learns it — but the engine only writes the index when the vault's *content* changed, and on a typical launch nothing has, so the record was never written and the next launch re-read the whole vault again, forever. The index now also persists when it is holding metadata the file lacks, so the upgrade lands on the first launch and every one after it is fast. Both fields are type-checked when read, too: `metadata.json` lives in the vault, so a sync conflict can corrupt it, and a bad value now falls back to the slow-but-correct path and is rewritten rather than trusted.

## [0.9.5] — 2026-08-08

One optimization: launching the plugin stops re-reading the whole vault.

### Changed

- **Startup no longer re-reads every note in the vault.** The skip-unchanged scan was disabled after a reload on purpose: the index recorded which notes it had seen, but not which exclusion settings that verdict was made under, so trusting it could have let an "unchanged" note stand in for one a newly-added exclusion should hide. The safe answer was to re-read everything — measured at 2 000 file reads on a 2 000-note vault, at every launch, and those are real disk reads rather than cached ones. The index now records the scan config alongside the mtimes, so a reload can tell the verdicts still apply and skips straight to the fast path; when the config differs (an exclusion added while the app was closed) or is absent on an index from an earlier version, it re-reads and re-checks everything exactly as before.

## [0.9.4] — 2026-08-08

One fix: startups stop rewriting the whole index because of a blank note.

### Fixed

- **A single empty note no longer makes every startup rewrite the whole index.** The skip-unchanged fast path is driven by a map of note mtimes that only ever lived in memory, so after a reload the mtimes were re-derived from the indexed chunks — and a note that chunks to nothing (empty, or only whitespace) leaves no chunk to derive from. It therefore read as newly added on the first refresh of every session, and "something was added" is exactly what makes the engine persist. On a large vault that is a multi-megabyte serialize and write on the app's main thread at every startup, caused by one blank note, and it never settled because the next launch re-derived the same way. The mtime map is now persisted alongside the index and restored on load. The field is optional, so an index written by an earlier version still loads and simply writes the map on its next persist — no forced reindex.

## [0.9.3] — 2026-08-08

One hardening fix: the last tool that could be called without a rate limit now has one.

### Security

- **`list_projects` is now rate-limited like every other tool (60/min).** It was the only one of the ten without a limit, presumably because listing project names reads as trivial — but it lists every Markdown file in the vault and scans the paths, so its cost grows with the vault (~0.5 ms at 1 000 notes, ~3.5 ms at 20 000) and is spent on the app's main thread. An agent polling it in a loop could degrade the UI while every genuinely expensive tool beside it was bounded. The limits are also now enforced as a registry-wide invariant in the test suite, so a tool cannot be added later without one.

## [0.9.2] — 2026-08-08

One fix, to a privacy filter that could silently do nothing.

### Fixed

- **An excluded folder typed in a different case no longer indexes the notes it was meant to keep out.** Folder exclusions were matched case-sensitively, so an entry of `private` did nothing to a folder named `Private` — the notes stayed in the index and every read tool would serve them, with nothing in the UI to say the exclusion had no effect. Excluded tags and excluded path patterns had always folded case, so this was the one filter that failed in the unsafe direction. Folder matching (excluded *and* included) is now case-insensitive; on macOS and Windows the filesystem folds case anyway, so the two spellings were the same folder all along. **If you rely on an excluded folder, check the setting once: any entry that was silently doing nothing now takes effect, and those notes will leave the index on the next refresh.**

## [0.9.1] — 2026-08-08

A performance fix for one attachment format. Nothing else about the plugin changes, and no settings or stored data are affected.

### Changed

- RTF extraction no longer stalls the app on a large document. It walked the
  file one character at a time, allocating an array entry per byte, so a 19 MB
  document took 1.2 s and 212 MB of heap to produce text the 1 MB extraction cap
  immediately truncated. It now takes each run of body text in a single slice:
  the same document extracts in 91 ms using 23 MB, with byte-identical output.

## [0.9.0] — 2026-08-06

Attachments become memory — and the release is mostly about what that made necessary. Text now comes out of PDFs, Office and LibreOffice documents, RTF, plain text, Canvas boards, and (opt-in, by delegating to the Text Extractor plugin) images. Everything else here is the work of making an untrusted-file pipeline safe to leave running: bounds on what one file can cost, on what a whole vault of them can cost, and on how long any of it may take — because a parser that hangs throws nothing for a `catch` to see. Alongside that, four security fixes to existing paths, one of which was writing your server token and embedding API key into the vault in plaintext. **If you have enabled the local server or an embedding provider, rotate both and delete `Claude Code/Config/plugin-settings-backup.json`.**

### Security

- **A stuck OCR call can no longer wedge a refresh.** Indexing text inside images delegates to the Text Extractor plugin, and that call had no time bound — slow is fine, but a call that never settles throws nothing for a `catch` to see, so the refresh waiting on it would never finish. It is now bounded at five minutes per image: generous on purpose, since the companion plugin downloads its language data on first use, so a timeout means genuinely stuck rather than merely slow. PDF parsing gained the same bound in this release; both share one helper, which is unit-tested in its own right.

### Changed

- **The minimum Obsidian version is now 1.7.2** (was 1.5.0). The control-panel view calls `workspace.revealLeaf`, which returns a promise as of 1.7.2 — so the manifest was claiming support for versions the code did not actually target. The call is now awaited as well, rather than leaving a promise unhandled.

### Security

- **The settings backup no longer writes your server token and embedding API key into the vault in plaintext.** Every settings save also writes `Config/plugin-settings-backup.json` as a recovery point, and it contained the full settings object — including both secrets. That file lives inside the vault, so it travelled everywhere the vault goes: Obsidian Sync, iCloud or Dropbox, and any git remote the vault is committed to. Secrets are now redacted with the same rule the logger already applied to console output. Nothing reads the file back, so the recovery point is unaffected — the fields are present and marked redacted rather than dropped. **If you have enabled the server or an embedding provider, treat the existing backup file as exposed: rotate the token and key, and delete or overwrite the file.**

- **A proposed memory can no longer forge the review inbox's format.** `add_memory` is reachable over the local MCP server and its fields land in a line-oriented Markdown file, so a newline inside a single-line field was not bad data — it was a forged line. A tag of `"x\nStatus: applied"` wrote a real `Status:` line into the block, and a related path containing `## Pending Memory:` forged an entire second entry, which the review UI then showed as a separate proposal with its own type and destination. Single-line fields are now collapsed and a block heading inside `content` is neutralized, at `renderPendingBlock` — the one producer of the format. Content is preserved (it is legitimately multi-line), and a parsed block still re-renders byte for byte.

- **`add_memory`'s size limits can no longer be walked around through a list field.** `content` was capped at 50 000 characters, but `tags` and `relatedPaths` were capped only by how many items they held — each item's length was unbounded, so the same payload fit in a list field instead, bounded only by the 1 MB request body. Items are now bounded too (`tags` 64 × 128 characters, `relatedPaths` 128 × 512), sized to what the fields actually are: a tag is a word, a related path is a vault path.

- **A PDF that wedges the parser can no longer wedge the refresh.** Extraction guarded against files that *fail* — corrupt, encrypted, unparseable — but not against one that never finishes: a parser that spins throws nothing for a `catch` to see, so the await simply never settles and the indexing pass waits on it forever. One document now gets 60 seconds, far past any real PDF and far short of a user noticing a stuck refresh; past that it is treated exactly like a file that failed to parse, and skipped. The HTTP client already raced Obsidian's un-abortable `requestUrl` against a timer for the same reason.

- **A single large attachment can no longer flood the index.** File reads were capped at 50 MB but the text an attachment contributed was not, and the two are only loosely related — the PDF and Office extractors cap pages and parts, yet a plain 50 MB csv, an RTF, or a docx whose whole body sits in one part had no bound at all. A 2.8 MB text file measurably produced 3.04 MB of indexed text across thousands of chunks; extracted text is now capped at 1 MB per attachment and says when it was clipped. 1 MB comfortably holds a whole book (~2 000 characters a page over 500 pages), so real documents are unaffected, and a no-text attachment still indexes as no text rather than as a truncation notice.

- **Nor can a thousand attachments abort every refresh.** The per-file ceiling bounds one document and says nothing about a vault full of them, while the extraction cache and the index are each a single JSON document. V8 refuses to build a string past ~512 MB, so roughly 516 attachments at the per-file ceiling made `JSON.stringify` throw `RangeError: Invalid string length` (measured) — an abort partway through indexing, not a degradation, leaving the vault unable to finish a refresh at all. All attachments together now contribute at most 32 MB of text per scan (~8 million tokens, far past what retrieval usefully serves); anything past it is skipped in scan order, logged, kept out of the extraction cache, and reported as "Attachments skipped" in the control panel so a partial index is visible rather than silent.

### Fixed

- **The installer's checksum verification works on macOS, and no longer skips an asset it cannot account for.** `scripts/install.sh` verified downloads with `sha256sum`, which is GNU coreutils and absent from a stock macOS — a platform the script explicitly supports — so every macOS run died with `checksum verification FAILED`, blaming the release for a missing tool. It now uses whichever of `sha256sum`, `shasum`, or `openssl` is present, and says plainly when none is. It also checks each asset against its own entry rather than running `sha256sum -c --ignore-missing`, under which a downloaded file absent from `SHA256SUMS` was silently never verified; that is now a refusal.

- **A failed file write no longer loses the file it was replacing.** Writes go to a temp sibling and are renamed into place, which protects against a half-written file — but because Obsidian's `rename` refuses an existing target, the old copy was deleted first, and the failure path then deleted the temp copy too. A rename that failed in between (a Windows file lock from a sync client or antivirus is the usual cause) therefore destroyed both the old content and the new. The previous copy is now moved aside instead of deleted, restored if the rename fails, and if even the restore fails both copies are kept and named in the error message. This is the path every index, cache, and inbox write goes through.

- **The MCP handshake no longer agrees to a protocol version it does not implement.** `initialize` echoed whatever `protocolVersion` the client sent, so a client asking for a revision this server has never spoken — including ones newer than it — was told yes, and would then proceed on that promise. The 2025-06-18 lifecycle spec is explicit: agree to the requested version when supported, otherwise answer with the latest the server does support and let the client decide whether to disconnect. Three revisions are now declared and honoured (`2025-06-18`, `2025-03-26`, `2024-11-05`) because the four methods this server implements are wire-identical across them; anything else is answered with `2025-06-18`.

### Changed

- **An incremental refresh no longer re-reads the tags and links of every attachment.** The markdown side of a refresh is O(changed), but the attachment pass walked all attachments each time and re-derived their metadata from text that had not changed, on the main thread, for every debounced auto-index. A warm refresh of 300 attachments went from **11.8 ms to 1.1 ms**; over link-dense text at the 32 MB corpus budget the re-derivation alone measures **716 ms**. Metadata is now cached alongside the extracted text. A cache file written before this field upgrades in place, so no attachment is re-extracted, and tag exclusions are still applied at emit time, so changing excluded tags re-evaluates without re-extraction.

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

[Unreleased]: https://github.com/nfoav8or/coder-engram/compare/0.10.7...HEAD
[0.10.7]: https://github.com/nfoav8or/coder-engram/releases/tag/0.10.7
[0.10.6]: https://github.com/nfoav8or/coder-engram/releases/tag/0.10.6
[0.10.5]: https://github.com/nfoav8or/coder-engram/releases/tag/0.10.5
[0.10.4]: https://github.com/nfoav8or/coder-engram/releases/tag/0.10.4
[0.10.3]: https://github.com/nfoav8or/coder-engram/releases/tag/0.10.3
[0.10.2]: https://github.com/nfoav8or/coder-engram/releases/tag/0.10.2
[0.10.1]: https://github.com/nfoav8or/coder-engram/releases/tag/0.10.1
[0.10.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.10.0
[0.9.9]: https://github.com/nfoav8or/coder-engram/releases/tag/0.9.9
[0.9.8]: https://github.com/nfoav8or/coder-engram/releases/tag/0.9.8
[0.9.7]: https://github.com/nfoav8or/coder-engram/releases/tag/0.9.7
[0.9.6]: https://github.com/nfoav8or/coder-engram/releases/tag/0.9.6
[0.9.5]: https://github.com/nfoav8or/coder-engram/releases/tag/0.9.5
[0.9.4]: https://github.com/nfoav8or/coder-engram/releases/tag/0.9.4
[0.9.3]: https://github.com/nfoav8or/coder-engram/releases/tag/0.9.3
[0.9.2]: https://github.com/nfoav8or/coder-engram/releases/tag/0.9.2
[0.9.1]: https://github.com/nfoav8or/coder-engram/releases/tag/0.9.1
[0.9.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.9.0
[0.8.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.8.0
[0.7.1]: https://github.com/nfoav8or/coder-engram/releases/tag/0.7.1
[0.7.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.7.0
[0.6.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.6.0
[0.5.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.5.0
[0.4.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.4.0
[0.3.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.3.0
[0.2.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.2.0
[0.1.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.1.0
