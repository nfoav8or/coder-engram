# Changelog

All notable changes to Coder Engram are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.14.1] — 2026-09-01

A correctness release from the post-0.14.0 review loop: four defects, three of
them silent, plus the documentation and benchmark gaps that let them stay
invisible. **No `INDEX_VERSION` bump** — see the note under the chunker fix for
what that means for a vault that already hit it.

### Fixed

- **A note whose heading line was longer than the chunk window lost its own
  text.** The window budget subtracts the heading — which is repeated into every
  window — from `maxChars`, and floored the remainder at 1 character. A heading
  longer than the window (about 1,850 characters with the shipped settings) drove
  that floor, and the body was then sliced ONE CHARACTER AT A TIME: 420
  characters of text became 360 chunks of ~2.6 KB each, no chunk held a whole
  word, and the note could not be found by searching for anything written in it.
  Nothing bounds a Markdown heading — a pasted line that happens to start with
  `#` is one — so this needed no unusual note, only an unlucky one. The body now
  keeps at least half the window whatever the heading costs; a window that runs
  over its budget is a cost, a note silently absent from its own index is a lie.

  **No index rebuild is forced for this.** Chunking is only re-run for a note
  whose mtime moved, so a vault that already has a note in this state keeps its
  shredded chunks until that note is edited. Forcing every user to re-index (and
  re-embed, at cost) one release after 0.14.0 already did, for a pathology this
  rare, was the worse trade — but it does mean the repair is "touch the note",
  not "upgrade".

- **A superseded memory could keep being served while reporting that it was
  retired.** Applied memory content lands in the file verbatim, and a retired
  section ends at the next heading of the same or a shallower level — so an
  ordinary `## ` line inside the content ended the block early. Retiring that
  memory removed the text above the line and left everything below it in place,
  while `applyPendingMemory` reported `recorded` and the reviewer was told the
  memory had been retired. Headings inside applied content are now nested one
  level below the block's own, which keeps them headings — the author's
  structure survives, where neutralizing them would have mangled it. This is the
  same shape as 0.14.0's unbalanced-fence fix, one door further along.

- **A `supersedes` reference that was not already canonical recorded a
  retirement that could never match.** The reference is validated with a check
  that normalizes both sides before comparing, so `…/Global/./profile.md` passed
  — but the key was then built from the string as typed, while every place that
  key is later consulted builds it from a real note path. The retirement was
  recorded, reported as `recorded`, and silently matched nothing: search and both
  context reads kept returning the memory the reviewer had retired. The parsed
  reference now carries the canonical path, which fixes the reading side of
  existing ledgers too, since both sides go through the same parser.

- **`tokenBudget` could be exceeded several times over by a single result.**
  Every result label and structured record embeds the chunk's heading path, and
  a heading has no length bound; the page-assembly helper deliberately keeps the
  first result whatever its size, on the understanding that its caller applies a
  hard ceiling afterwards. The two search tools were the ones that never did. A
  5,000-character heading answered a 256-token request (896 characters) with
  5,271 — in the prose and in the structured payload. Heading labels are now
  bounded where they are built, which fixes `find_symbol` and
  `find_related_notes` at the same time, and both search tools apply the ceiling
  their helper's contract asks for.

- **A truncation notice was added on top of the cap instead of counted against
  it**, so any clipped answer overran its own `maxChars` by the length of the
  "…(truncated at N chars; …)" line. A cap is a promise about the size of the
  answer, and it was broken in exactly the case where the caller was nearest to
  it.

- **A truncated answer could end in half a character.** Every cap lands on an
  arbitrary offset and an astral character — an emoji, some CJK extensions —
  occupies two UTF-16 units, so a cut between them left a lone surrogate.
  That is not valid text: encoding the JSON response to UTF-8 replaces it with
  U+FFFD, so the caller received a corrupted final character rather than a short
  one. All five truncation sites now back off a unit rather than split a pair.

- **`get_note_context` reported a note whose every section had been retired as
  "not indexed"**, sending an agent to reindex a note that is indexed and
  deliberately empty of servable content. The tool had its own copy of a refusal
  the engine already knew how to make properly; there is now one answer to "why
  can this note not be served", and it belongs to the engine, which is the only
  layer that knows both what is indexed and what was retired.

- **`estimatedTokens` was emitted but never declared.** Both search tools put it
  in `structuredContent` while their `outputSchema` said nothing about it — a
  field a client building its call from the published schema cannot rely on,
  which is the same defect as an enforced-but-undeclared argument.

### Changed

- The scale benchmark's corpus now contains fenced code (about one section in
  six declares something, giving 10.5% symbol-bearing chunks). It previously
  contained none at all, so `extractSymbols` returned an empty array for every
  one of its 14,407 chunks and the benchmark could not see the symbol index it
  was being used to judge — the fourth instance of this repo's "a probe that
  cannot detect the thing it is measuring proves nothing" lesson. The run now
  prints the symbol-bearing proportion, so a corpus that stops exercising the
  feature says so. **Its numbers are a new baseline** and are not comparable to
  those recorded for 0.13.0 and 0.14.0, which were measured on the old corpus.

- Documentation said seven tools return `structuredContent`; eight do —
  `find_symbol` was added after that prose was written and never joined the
  list, which the code's own pinning test had been asserting correctly all along.

- Housekeeping with no behaviour change: the dead `EngramEngine.getMemoryStore`
  accessor is gone, the two whole-file context tools share the renderer they had
  been duplicating, `ToolHandler` stops being exported (nothing outside its file
  used it), and chunks that declare no symbols share one empty set instead of
  allocating one each.

### Performance

- **Nothing measurable, reported as such.** 0.14.0 recorded a ~9% lexical query
  regression and attributed it to the symbol index. Two candidate fixes were
  written and benchmarked against the shipped code, three runs each, alternating:
  the difference between them was smaller than the spread within either group, on
  a corpus with symbols and on one without. Both were reverted rather than
  shipped as improvements that cannot be shown. What the investigation did
  establish is the benchmark gap above — the regression was measured on a corpus
  where the feature never fired, so every millisecond of it was overhead paid by
  vaults that contain no code at all.


## [0.14.0] — 2026-08-31

> **This release rebuilds your index once, on first load.** `INDEX_VERSION` moved
> from 6 to 7 because chunks now carry the symbols their fenced code declares —
> a derived field, so an older index cannot be repaired by a refresh: only notes
> whose mtime happened to move would gain symbols, leaving the corpus scored two
> different ways. Nothing in `Claude Code/Memory/` is touched; `Index/` is a
> rebuildable cache and this is what rebuilding it is for.

### Added

- **The inbox is parsed once, not on every read.** `readInbox` re-read and
  re-parsed the whole file on every call while `proposeToInbox` kept a cache of
  its own — so the flow `list_pending_memory` prescribes (check what is pending,
  then propose) parsed the same file twice, and the review UI re-parsed it after
  every apply and discard. 0.13.0 documented this cost rather than fixing it;
  this fixes it.

  The three mtime-keyed caches in `MemoryWriter` — the rejection ledger's keys,
  the supersession ledger's keys, and now the parsed inbox — became one
  `FileDerivedCache`. They had drifted apart in small ways while claiming to
  follow one rule, which is how a cache quietly stops being correct. The rule is
  now stated once: a null mtime means nothing to read, and every writer in the
  class **seeds or clears explicitly** rather than trusting the mtime to have
  moved, because mtime resolution is coarse on some filesystems and two writes in
  one tick can share a value.

  Apply and discard clear the inbox cache **after** their write as well as
  before it. `readInbox` deliberately runs outside the inbox lock — the review UI
  and `list_pending_memory` both call it — so a read landing between a pre-write
  clear and the write itself repopulates the cache with pre-write content, and
  if that write's mtime collides with the one it cached under, nothing clears it
  again: the applied or discarded entry reads as pending forever. Caught in
  review, with a regression that reproduces the interleaving. The dedup cache deliberately stays outside it — its
  null-mtime rule is the opposite, because there it guards an append and treating
  "no mtime" as "no file" would overwrite an inbox full of unreviewed memory.

- **Code-aware chunking and a symbol index.** Retrieval treated every note as
  prose, so a chunk containing `export function resolveInVault(…)` matched the
  query "resolveInVault" as an ordinary body term — competing on frequency with
  every passing mention of the same name. The declaration and the mention scored
  the same, which is backwards: for an identifier, the place it is *defined* is
  almost always the passage you wanted. Measured on a small corpus, the note
  that merely name-dropped the symbol five times outranked the one that declared
  it.

  Chunks now carry the names their **fenced code** declares, and a query term
  naming a declared symbol earns credit on top of whatever the body scores.
  Unlike the filename/alias credit, it is **not** conditional on the term being
  absent from the body — a declaration line *is* body text, so gating it that
  way meant the boost could never fire on the very chunks it exists to promote.
  It scales with IDF like every other component, so it is decisive for a rare
  identifier and nearly nothing for a name the whole vault uses.

  **`find_symbol`** answers the question a search answers badly: where is this
  defined? An exact name match against declared symbols, returning locations and
  snippets rather than every passage that mentions the name.

  It **never answers with the review inbox**. That folder is an ordinary indexed
  note and `add_memory` content lands in it verbatim, fences included, so an
  agent that wrote a fenced function into a proposal could otherwise read its own
  unreviewed text back as an authoritative declaration. Search *labels* inbox
  hits because a proposal may still answer a query; a proposal is not a
  definition, so here it is excluded outright. Its snippet is a **single line
  windowed onto the declaration**, for two reasons found in review: slicing from
  the chunk start returned snippets that never showed the declaration at all
  (chunks run to 2,000 characters), and raw multi-line text let an indexed note
  forge a second numbered entry attributing its content to a path the tool never
  matched — the forgery this server already closes for search snippets.

  The extraction is deliberately shallow — a handful of declaration keywords
  that mean the same thing across languages, no parser and no dependency. It
  will miss things, and that is the right trade: a missed symbol costs a boost,
  while a wrong one mis-ranks a note for a name it never defined. Only fenced
  code is read, because prose containing the word "class" is not a declaration,
  and a `const` counts only when it is bound to something callable — otherwise
  every local variable in every snippet becomes an API. Capped at 32 symbols per
  chunk so a generated or minified block cannot bloat every persisted index.

  `npm run eval` is unchanged (all classes 1.00 recall@8, plural MRR 0.92), which
  says the change did not regress the golden queries. It does not measure the
  gain: the eval corpus has no fenced declarations, so the symbol path is not
  exercised by it. The improvement is demonstrated by a regression test instead.

- **A per-call token budget.** The tools accepted `maxChars`, but characters are
  not the unit anyone budgets in: an agent has a context window measured in
  tokens, and converting between the two in its head is exactly the arithmetic
  it should not have to do. **`tokenBudget`** lets it ask in its own unit, on
  the nine tools whose output can be large: `search_vault_memory`,
  `search_batch`, `get_note_context`, `get_project_context`,
  `get_global_context`, `get_recent_sessions`, `get_recent_changes`, and both
  inbox listings. The rest already answer in a sentence or under a fixed
  ceiling, where a budget would be a knob with nothing behind it.

  It is an **estimate**, named like one, and conservative in the direction that
  matters: a budget converts to fewer characters than it might really buy, and a
  reported estimate is higher than the text probably costs. Overshoot is the
  dangerous side — an agent that asked for 2,000 tokens and got 3,000 has had
  the decision taken away from it. No tokenizer is bundled; one would be a poor
  trade for a plugin whose point is to stay small and offline.

  Given both `tokenBudget` and `maxChars`, the **tighter wins** — they are two
  spellings of one request, and resolving it any other way would let a generous
  `maxChars` quietly undo an explicit budget. Search trims at **result
  boundaries**, never mid-snippet: a half-snippet spends tokens on a passage the
  agent cannot use. The budget is validated with the other arguments rather than
  where it is first used, so a bad value is refused whatever the results turn out
  to be, instead of being accepted on an empty vault and rejected on a full one.
  Tools with a structured payload report `estimatedTokens` in it, so an agent can
  calibrate rather than guess.

- **Structured results — citations as fields, not a parsed label.** The eight
  tools whose answers are lists now return MCP `structuredContent` beside their
  prose: `search_vault_memory`, `search_batch`, `list_pending_memory`,
  `list_rejected_memory`, `get_recent_changes`, `resolve_project`,
  `list_projects`, and `find_symbol`. A caller that wants to cite a passage reads `path`,
  `startLine`, `endLine` as fields instead of parsing them back out of a
  `path › heading (L4–9, 2026-07-03)` string that was written for a human.

  **Alongside, never instead of.** `content` still carries the whole answer, so
  every client that predates this — including the protocol's own default — loses
  nothing. `pendingReview` is in the structured form for the same reason, since
  a consumer reading only fields would otherwise lose the one caveat that
  matters most: that a hit from the inbox is an unreviewed proposal, not settled
  memory.

  **One decision, two halves.** The listings work out what fits in `maxChars`
  at **entry boundaries** and build both the prose and the payload from that
  same slice, rather than rendering everything and slicing the joined text
  afterwards. The naive version left `maxChars` bounding only the channel a
  caller happened not to be reading — a 1,000-character request measured 491 KB
  of proposal content in `structuredContent`. Each entry's own text is bounded
  the same way, and `total` still says how much was left out. Listing entries
  now also name what they claim to replace in the prose, not only in the fields.

  `outputSchema` is declared for exactly those eight and no others, and a test
  pins that both ways: a schema without a payload is a promise the server does
  not keep, and a client that validates would be right to reject the call.

- **Memory ageing — a settled fact stops outranking a recent one.** Every memory
  was equally true forever: a decision from eighteen months ago outranked last
  week's on term frequency alone. Recency existed only as a *filter*
  (`sinceDays`), which is all-or-nothing — it either hides old memory outright or
  ignores age completely. **Memory ageing (half-life in days)** in settings makes
  it a ranking signal instead, halving a memory's weight every N days.

  **Off by default**, because it changes scoring semantics. Three properties
  matter more than the curve. It applies to **memory only** — ordinary notes are
  documents, not claims that go stale, and ageing the whole vault would change
  what search means for everyone who wanted this for their memory. It is
  **floored** at a quarter weight, so an old memory ranks lower but never becomes
  unfindable: ageing orders memory, it does not delete it. And it dates each
  memory from the timestamp its applied heading carries, **not** the file's
  mtime — dating by mtime would make adding one decision refresh every older
  decision beside it, and decay that resets itself is worse than none because it
  looks like it works.

  It runs last, in the engine — it multiplies a score that does not exist until
  the retriever has produced one, and keeping it there spares all three
  retrievers the same re-weighting plus the settings and clock dependencies they
  are deliberately free of. A memory dated in the future scores 1 rather than
  more: clock skew and hand-typed headings both produce those, and a wrong date
  must not be a way to win every ranking.

- **Overlap with existing memory, flagged when it is proposed.** `add_memory`
  checked for *duplicates* — an exact restatement was absorbed — and for nothing
  weaker. So an agent proposing "we moved to Postgres" while memory said "we
  chose SQLite" got both stored, silently, and retrieval later returned the pair
  with nothing to say which was current: the accumulation of contradictions that
  made superseding necessary. Every proposal is now scored against existing
  memory, and the closest match is named back to the agent and shown on the
  review card.

  **Deliberately narrower than "contradiction detection", and worded that way
  everywhere.** It finds the memory with the highest lexical overlap; it does not
  decide that two memories disagree, which nothing offline can. It names the
  candidate and the one action that resolves it — re-propose with `supersedes`
  if this replaces it, leave it alone if it only adds detail — and puts the
  judgement where it belongs.

  Skipped on a direct write (the annotation is for review time, and a direct
  write has no review) and when the proposal already names what it replaces. It
  runs inside a write path, so it is offline (no query embedding: the
  retriever degrades to its lexical component without one), scoped to the memory
  root, and **total** — any failure means "no overlap", never a failed proposal.
  Pending proposals and the ledgers are excluded, because overlapping something
  nobody has approved is not news and `supersedes` cannot name it. The field is
  computed by the engine and has no place in the tool schema: it is an
  observation about the vault, not a claim the proposer gets to make.

- **Supersede a stale memory — memory that can be revised, not only appended.**
  Dedup deliberately keeps a restatement that adds detail, so contradictory
  memories accumulated and nothing could ever be retired. A stale memory is
  worse than no memory, because it still reads as settled knowledge. A proposal
  may now carry **`supersedes`**: the `"<path>#<heading>"` of the memory it
  replaces, taken straight from a search result's label. Applying it retires
  that memory — search stops returning it and `get_project_context` /
  `get_global_context` replace the section with a visible `— superseded` marker.

  **Nothing is overwritten**, which is what lets this coexist with the
  apply-is-always-an-append invariant. The original text stays in its file; a
  record is appended to `Memory/Inbox/superseded-memory.md`, and deleting that
  record brings the memory straight back. The retirement is a decision you can
  read, audit, and undo, not a deletion.

  **Two rules bound what can be retired, and both are load-bearing.** The target
  must be **inside the memory root** — retiring is a hide, so a reference able
  to name any vault note would let an agent's proposal quietly suppress the
  user's own writing. And it must **name a heading**: a bare path would retire a
  whole file in one click, and a reviewer approving "this replaces that
  decision" is not approving the loss of everything else in the file. A
  reference failing either is refused at `add_memory`, so it never reaches the
  inbox for someone to approve.

  Retiring stays **human-gated**: `supersedes` on a proposal is a *claim*, and
  nothing in the tool surface can promote it. The review card names the memory
  that will be retired, above the content. A reference that no longer resolves
  when you apply does not fail the apply — the new memory is what you approved —
  it retires nothing and says so.

  Every door is closed, not just the obvious ones: `search`,
  `get_project_context`, `get_global_context`, `get_note_context`, and
  `summarize_note` all stop serving a retired section. The last two read a
  note's chunks, so they share one choke-point (`getReadableNoteChunks`) — the
  raw chunk accessor stays unfiltered because its other callers ask whether a
  note is indexed, which a retirement does not change.

  Three things keep a retirement from taking more than it named. Applied
  content has its **code fences balanced** before it is written: content lands
  in the file verbatim, and an odd number of fence markers desynchronizes every
  fence-aware reader to the end of the file — which made one crafted memory able
  to hide every section applied after it. Applied headings carry a **short
  content-derived anchor**, because `timestampLabel` has minute granularity and
  a reviewer working through a backlog applies several same-type entries inside
  one minute routinely, producing byte-identical headings where retiring one
  retired the other. And a reference whose heading matches **more than one**
  section retires **neither**, reporting `ambiguous` — a legacy file can still
  hold a repeated heading, and removing a memory nobody named is the one harm
  this mechanism must never cause.

  Heading detection is now one function (`scanMarkdownLines`, exported from the
  chunker) rather than a second copy. The copy disagreed with the original on
  trailing `#`s and on mismatched fence markers, so a section could chunk one way
  and be retired another.

  Search is filtered **after** ranking, never before: dropping the chunks first
  would change the BM25 corpus statistics every other result is scored against,
  so retiring one memory would silently re-rank unrelated notes. Section
  matching is fence-aware, so a `#` comment in a code block cannot be mistaken
  for a heading and drop the wrong text.

- **The rejection ledger — the agent finally learns what a "no" means.** 0.13.0
  let an agent see what was *pending*; it still could not see what was
  **rejected**, or why. A discarded proposal simply vanished, which is
  indistinguishable from one nobody has reviewed yet — so the agent's only
  rational move was to keep proposing, and reviewers kept dismissing facts they
  had already turned down. Discarding now records the proposal, with the
  reviewer's reason, in `Memory/Inbox/rejected-memory.md`, and the new
  **`list_rejected_memory`** tool reads it back.

  An identical proposal is refused while its record stands, and `add_memory`
  says so *with the reason* rather than reporting a bare "not added". The match
  is the same **exact** content/type/project identity the dedup uses — a
  proposal that rephrases or adds real detail is a different memory and still
  gets through, so one "no" can never silently swallow every later, better
  version of the same fact.

  **Discard now asks why.** The prompt doubles as the confirmation that
  irreversible button never had: cancelling it cancels the discard. The reason
  is optional, and is what the agent reads back — "wrong project" stops it
  repeating a mistake that a bare removal taught it nothing about.

  A reviewer who later types the same memory themselves **overrides their own
  earlier rejection** and the stale record is dropped with it: that is the same
  person changing their mind, and silently discarding what they just typed
  would be indefensible. **Clear rejections** in the review modal forgets the
  lot, and deleting a single record by hand un-rejects just that memory.

  The ledger is capped at 200 records (oldest fall off) so it cannot grow
  without bound on a path that is read on every proposal, and it is
  **best-effort by design**: the inbox is written first, so a ledger failure
  loses only the feedback and never fails the discard the user asked for — and
  can never leave a record claiming a still-pending entry was rejected.

  `list_rejected_memory` is **read-only**, like `list_pending_memory`. Clearing
  the ledger — un-rejecting a memory — is a reviewer decision and stays out of
  `ALL_TOOLS` entirely, for the same reason promotion does.

## [0.13.0] — 2026-08-28

### Added

- **`list_pending_memory` — the agent can finally see its own proposals.**
  `add_memory` reported only that a proposal landed, so an agent could not tell
  an accepted memory from a rejected one from a still-pending one. It
  re-proposed facts it had already contributed and the writer's dedup silently
  absorbed them: a loop open in one direction, and the reason memory quality
  decayed across sessions instead of accumulating. The new tool lists what is
  awaiting review, with an optional `project` filter folded for case and
  Unicode form like every other project filter.

  **Read-only, deliberately.** It reports on the review queue and cannot act on
  it — applying or discarding an entry stays UI-only and absent from
  `ALL_TOOLS`, because a tool that could approve its own proposal would
  collapse the human-in-the-loop design the inbox exists for. It takes no path
  argument and reads only `pending-memory.md`, so it is not a general file
  reader. Entries come back **newest first**, so the entry limit and the
  character budget drop the same end — ordered oldest-first, the limit kept the
  newest and the clip then threw them away, leaving an agent asking "what did I
  just propose" looking at the oldest entries.

  Content is rendered with heading and `---` lines defused. Without that, one
  proposal whose content carried those lines rendered as two apparent entries,
  and the consequence landed precisely on this tool's purpose: an agent that
  believes a fact is already pending suppresses a genuine proposal.

- **`get_recent_changes` — a cheap session warm-start.** An agent resuming work
  needs to know what moved since it last looked, and the only way to ask was a
  search: it had to invent a query for something that is not a relevance
  question, then hope ranking surfaced recency. This answers it directly from
  the note→mtime map the index already holds — no I/O, no embedding call, no
  scoring — and returns paths and dates rather than content, so the agent
  chooses what to spend context on and follows up with `get_note_context`.

  `sinceDays` takes fractions (an hour is about 0.04), because "what changed in
  the last hour" is the question that actually gets asked. An empty index is
  reported distinctly from "nothing changed": the answer is unknown rather than
  negative, and conflating them is how an agent concludes a vault is idle when
  it is merely unindexed. Excluded notes cannot appear — the map holds only
  what was indexed, so the privacy controls are upstream of this by
  construction rather than by a filter here.

- **`resolve_project` — stop guessing the project name.** The agent knows a
  filesystem path; this plugin knows a folder name a person chose, and nothing
  connected them. A near miss — `coder-engram` for `Coder Engram` — returned
  empty context, which reads as "this project has nothing yet" rather than "you
  asked for the wrong name": the worst failure mode a memory tool has, because
  it looks like an answer. Matching folds case, Unicode form, and the `-`/`_`/
  space separators that distinguish a repository directory from a folder name.

  The hint is treated as text, never a path — only its last segment is read,
  nothing is resolved, and no filesystem outside the vault is touched. An
  ambiguous hint is reported as ambiguous rather than resolved to whichever
  name sorted first, and a miss names the projects that do exist, since an
  agent cannot otherwise tell a spelling error from a project nobody created.

  **The same fix applies in Obsidian.** The **Default project** setting is free
  text passed straight through, so a user who typed `coder-engram` for a folder
  named `Coder Engram` got an empty project panel and an empty session note —
  the identical silent miss. Both commands now resolve the typed name first,
  falling back to it unchanged when there is no single match, so an ambiguous
  or unknown name behaves exactly as before rather than being quietly
  redirected somewhere the user did not name.

- **`search_batch` — several related questions, one call, one budget.** An agent
  exploring a topic asks three or four overlapping questions. One at a time that
  is three or four round trips returning heavily overlapping results, each paid
  for separately in context. Batching removes the overlap once: a chunk
  answering three of the questions comes back a single time, annotated with
  which ones it answered.

  Fused by Reciprocal Rank Fusion — the same rank-based combination
  `HybridRetriever` already used to merge lexical with vector, now extracted to
  `retrieval/ranking.ts` as `fuseByRank` and shared by both. Scores from
  different queries are not comparable, so rank is the only honest way to
  interleave them, and a chunk several queries agree on ranks above one only a
  single query found — a signal lost entirely when the questions are asked
  separately.

  **It is not cheaper in provider work.** Each query still embeds separately in
  vector or hybrid mode, and the queries run sequentially so a batch never
  becomes a concurrent burst of provider calls. What it saves is round trips and
  duplicated context. It is charged once per query against the same budget as
  `search_vault_memory`, so a batch of five costs what five searches cost —
  batching is never the cheap way around the rate limit.

### Fixed

- **Memory dedup missed a case-variant project name.** The proposal dedup key
  folded content for case but the project for Unicode form only, so the same
  fact proposed under `engram` after `Engram` produced a second inbox entry.
  Case-variant project names are the norm rather than the exception — an agent
  derives one from a working-directory path, a user types another — and every
  other project comparison in the codebase already folds case. Found while
  reviewing `list_pending_memory`, whose whole purpose is closing the
  re-proposal loop this gap held open.

## [0.12.1] — 2026-08-28

### Fixed

- **An excluded path pattern could silently stop excluding.** Patterns past the
  safety caps (256 characters or 12 wildcards) are not compiled to a RegExp,
  because the `[^/]*` and `.*` a glob expands to backtrack catastrophically once
  enough of them combine. The fallback stripped the wildcards and tested
  `includes` on the remainder — turning `Private/**/*.md` into the literal
  `Private/.md`, a string essentially no path contains. The exclusion then
  matched **nothing**, and the notes it was meant to hide were indexed and
  reachable over the local MCP server, with nothing logged. The fallback now
  requires the pattern's literal fragments to appear **in order**, which is
  linear, cannot backtrack, and is a deliberate *superset* of the glob: for a
  privacy control, matching too much keeps a note out of the index and matching
  too little hands it to the agent, so only one direction is a safe way to be
  wrong. The degradation is now logged rather than silent.

  **No index rebuild is needed.** Path eligibility is re-evaluated on every
  scan, including the mtime fast path, so the first refresh after upgrading
  drops any note that was wrongly indexed. This is unlike the tag-exclusion
  fixes, which needed an `INDEX_VERSION` bump because their verdict depended on
  re-*reading* a note's content and a refresh only re-reads on an mtime change.

## [0.12.0] — 2026-08-28

### Changed

- **BREAKING: `minAppVersion` is now 1.13.0.** Obsidian will not offer this
  release to an older app. **Nobody is stranded and nothing breaks:**
  `versions.json` still maps every release up to 0.11.4 to 1.7.2, so an app
  below 1.13 is offered 0.11.4 and keeps a fully working plugin — it simply
  stops receiving new features. Users on 1.13 or later are unaffected and need
  do nothing.
- **The imperative settings tab is gone** — about 450 lines, and with it the
  duplicate definition of every settings row. Obsidian has ignored `display()`
  since 1.13 whenever `getSettingDefinitions()` returns anything, so this code
  had not rendered for a user on a current app in a long time; it existed only
  as the pre-1.13 fallback that the old floor required. Settings now have one
  source of truth, `setting-definitions.ts`, which is also what puts every
  setting in Obsidian's settings search.

### Fixed

- **The settings tab stated the containment guarantee, and 1.13+ users never
  saw it.** "All plugin-managed memory lives inside this vault… Nothing is
  written outside the vault" was a plain paragraph in the imperative tab with
  no declarative counterpart, so it disappeared for anyone on 1.13 or later the
  moment the declarative path took over — the one place the UI states the
  property the whole design rests on. Found by diffing the two paths row by row
  before deleting either, and restored as a definition of its own. This is a
  pre-existing gap, not one the deletion introduced.

### Added

- `npm test` now fails if the README's stated minimum Obsidian version drifts
  from `manifest.json`. Raising a floor is exactly the change that updates the
  manifest and forgets the prose, leaving the README telling users an older app
  will work when the release is not even offered to them. It caught this
  release's own stale line.

## [0.11.4] — 2026-08-28

### Fixed

- **Every rethrow now throws a provable `Error`.** `@typescript-eslint/no-throw-literal`
  defaults `allowThrowingAny` and `allowThrowingUnknown` to **true**, so our lint
  stayed green over six `throw err` rethrows of a caught `unknown` while
  Obsidian's review scan kept reporting them — the defaults are exactly what hid
  the class. Both options are off now, which surfaced five sites
  (`obsidian-vault-adapter.ts` ×3, `embedding-store.ts`, `index-manager.ts`).
  Each goes through a new `asError` helper: an existing `Error` is returned
  unchanged, so subclass identity and stack survive, and only a genuine
  non-`Error` is wrapped. Not lint appeasement — the vault adapter wraps a host
  API that can reject with a bare string, which previously propagated as a
  string to callers that all treat a failure as an `Error`.

### Changed

- **Timers are scheduled through a host-aware helper.** `utils/timeout.ts` gains
  `setTimer`/`clearTimer`, which use `window.setTimeout` when a window exists and
  the global otherwise. Obsidian asks plugins to schedule through `window` so a
  timer belongs to the window that created it and dies with a popout instead of
  firing into a detached document; calling `window.*` directly was not an option
  because the core and server layers also run under Node, where `window` does not
  exist and every unit test lives — it would have meant shimming a browser global
  into the test environment and giving the pure core a host dependency. All nine
  reported sites route through the helper, and `src/` now contains no bare
  `setTimeout`/`clearTimeout` identifier at all: the Node fallback reaches the
  global as `globalThis.setTimeout`, since a bare call is what the scan matches
  and writing one would have traded nine warnings for two. The three UI files
  that own a genuinely popout-scoped timer keep calling `window.setTimeout`.

- **The DNS-rebinding guard could compare two empty strings and call it a
  match.** `Host: :1234` is all port, so its hostname parses as `""`, and a
  whitespace-only configured host trimmed to an empty bound host — equal, so
  allowed. Reaching it required the non-localhost opt-in (which also forces a
  token) and no browser can be aimed at a URL with an empty host, so there was
  no practical attack; a guard still has to fail closed on a degenerate input
  rather than read it as agreement. Both sides must now be non-empty.
- **A whitespace-only server host bound every interface.** It is truthy, so it
  survived the `|| "127.0.0.1"` fallback and trimmed to `""`, which Node binds
  as a wildcard — the exact exposure `allowNonLocalhost` exists to gate. The
  host is trimmed before the fallback now. A corrupt non-string host is refused
  as the non-loopback value it stringifies to, rather than throwing a
  `TypeError` out of `.trim()` or being quietly read as localhost.

- A corrupt `data.json` holding a non-string `defaultProject` migrated cleanly
  and then crashed at first use. `migrateSettings` coerces every other field but
  merged this one through the blind spread, and both commands that read it guard
  only with `if (!project)` — which a truthy `42` or `{}` passes, reaching
  `sanitizeProjectName` and its `name.trim()`. The documented invariant is that
  a corrupt blob degrades to safe defaults *without throwing*; deferring the
  throw to the first project command defeats it from a different angle. Now
  coerced and trimmed like every other string setting.
- `add_memory` with a blank entry in `relatedPaths` wrote a bare `* ` bullet
  into `pending-memory.md`. `optionalStringArray` validates type and length but
  not blankness, so a malformed bullet reached the file the user reviews — and
  the inbox parser's `^\*\s+(.+)$` then dropped it, so the parsed view
  under-reported what was on disk. `renderPendingBlock`, the single producer of
  that format, now drops blank paths.
- Optional inbox fields could vanish across a render → parse → render cycle.
  Render gated on the raw field but wrote `oneLine(field)`, which collapses a
  truthy whitespace-only value to `""` — which the parser reads back as
  `undefined`. Every optional field is now gated on its collapsed value, and a
  blank status is written as the literal `pending` the parser would read from
  it. Not reachable today (nothing re-renders a parsed entry, and
  `formatMemoryEntry` hardcodes the status), but the module's contract is that
  parse and render agree, and it did not.
- `chunkMarkdown` shredded text one character per chunk when a caller passed
  `overlapChars >= maxChars`. Nothing related the two, so the per-piece budget
  fell to its floor of 1 and the whitespace-preferring splitter had no boundary
  that fit. `overlapChars` is now capped at half of `maxChars`, so at least half
  of every window is new content. `IndexManager` passes no `ChunkOptions`, so
  the shipped app always used the defaults (150 of 2000, far under the cap) and
  default output is byte-identical — this was a precondition of an exported pure
  function rather than a live defect.
- A summary could come back **empty, with no error**, if any sentence vector
  held a non-finite component. One `NaN` poisons the shared centroid, so every
  cosine is `NaN`, so MMR's `val > bestVal` is false on the very first pick and
  selection stops having chosen zero sentences — while still reporting
  `method: "embedding"`. `extractiveSummary` now uses the embedding backend only
  when handed one non-empty, all-finite, uniform-width row per unit, and falls
  back to lexical otherwise. The shipped providers cannot produce such a vector
  (`parseVectorMatrix` rejects non-finite cells and ragged rows before they
  leave the HTTP layer), and a probe through the real engine confirmed the
  existing path already degrades correctly; this makes the guarantee a property
  of the summarizer rather than of whichever caller supplied the vectors — the
  same check `EmbeddingStore.entriesMap` already performs for retrieval.
- The stored vector norm in `embeddings.json` was read back and used as-is.
  `n` is a cache of a value derived from `v`, and nothing on the load path could
  prove the pair was still in sync — `embeddings.json` lives in the vault, where
  a sync conflict can merge one field and not the other. A norm smaller than the
  true one inflates that entry's cosine past 1, and no downstream filter rejects
  a score above 1, so a single corrupt entry would outrank every honest match.
  `entriesMap` now recomputes the norm from the decoded bytes, at the cost of one
  multiply-add per component inside the finiteness loop that already walks every
  component, memoized with the decoded map. The on-disk format is unchanged.
- `VectorRetriever`'s two norm guards were `=== 0`, which a `NaN` norm passes.
  A `NaN` score then survives the `score <= 0` filter (every comparison against
  `NaN` is false) and sorts into results at an arbitrary rank. Both guards are
  now `> 0`. Not reachable through `entriesMap`, which filters non-finite
  vectors — this is the retriever holding its own invariant rather than
  inheriting it from its caller.
- The embedding worker pool's rethrow was typed as a thrown `null`, not a
  thrown `Error`. The pool captures its first failure into a closure-assigned
  variable, and TypeScript does not track writes made inside a closure — so at
  the rethrow it still believed the variable held its initialiser, and
  considered the failure path unreachable. Confirmed by making the compiler
  print the resolved type; annotating the union did not help, because the
  narrowing re-derives from the initialiser. The failure is now held in an
  `Error[]`, whose element type is unconditional. Flagged by Obsidian's
  automated review of 0.11.3 — a second, distinct instance of a rule whose
  first instance was fixed in 0.11.0.

### Changed

- `npm run lint` now enables `@typescript-eslint/no-throw-literal`. It is not
  part of `recommended-requiring-type-checking`, so it had to be named
  explicitly — which is why two real defects of the same shape reached Obsidian's
  review scan instead of failing our own lint first. Verified by restoring the
  old pattern: the project's lint now reports it. Two neighbouring options were
  surveyed and deliberately left off, with the counts recorded in
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): `no-unnecessary-condition` (31
  findings, every one sampled a correct defensive check the type model believes
  is redundant) and `noUncheckedIndexedAccess` (122 errors, nearly all
  loop-bounded accesses that are provably safe).
- The plugin-review table in [docs/ROADMAP.md](docs/ROADMAP.md) now spells out,
  for each finding deliberately left alone, exactly what the trade-off buys —
  including every one of the nine timer call sites and why the three UI files
  that *do* own a popout-capable timer correctly use `window.setTimeout` while
  the rest do not. These findings recur in every review by design; the rows
  exist so the decision is visible rather than re-derived each time.

## [0.11.3] — 2026-08-28

Two more ways tag exclusion could fail open, **one of them a regression 0.11.2
itself introduced**. If you are on 0.11.2, upgrading is worth doing promptly.

**On upgrade:** `INDEX_VERSION` goes to 6, so the index rebuilds once more.
Re-chunking only — cached vectors are reused.

### Security

- **A stray line after a real key ended the frontmatter scan, losing the tags
  behind it.** 0.11.2 bounded the unterminated-frontmatter scan so a document
  that merely opens with `---` as a horizontal rule could not adopt a `tags:`
  or `title:` line out of its own body prose. That bound went one step too far:
  it also stopped the scan *after* a genuine `key: value` had already
  established the block as frontmatter. Unresolved git merge-conflict markers
  between two keys, or any hand-edit or sync conflict that drops a plain line
  mid-block, lost every tag that followed. **0.11.1 found those tags and 0.11.2
  did not** — a note the user had excluded was indexed and served. Once a real
  key has been seen the block is frontmatter and a later stray line is now
  skipped rather than ending the scan; the horizontal-rule protection is
  untouched, because it rests entirely on no key having appeared yet.
- **A blank line or a comment inside a `tags:` block list dropped every tag
  after it.** Both are legal YAML inside a sequence, but any non-`key: value`
  line cleared the key that later `- item` lines belong to. Unlike the case
  above this was never specific to a damaged file — it applies to ordinary,
  correctly terminated frontmatter, and predates 0.11.2.

### Tests

672 → 677. Both fixes are covered by tests confirmed to fail without them, and
the first is pinned against the exact shapes 0.11.1 handled and 0.11.2 did not.

## [0.11.2] — 2026-08-28

A correctness and honesty release. Three of the fixes below close ways the
**tag-exclusion privacy control could fail open** — a note the user had marked
to keep away from the agent was indexed and served anyway — and two fix real
costs that 0.11.1 itself introduced for anyone who upgraded to it.

**On upgrade:** `INDEX_VERSION` goes to 5, so the index rebuilds once. That
rebuild re-chunks but does **not** re-embed — cached vectors are reused, which
is itself one of the fixes below.

### Security

Tag extraction decides whether an excluded note stays out of the index and away
from the local MCP server, so a tag the parser misses is a note that leaks.
Three separate misses, all in the same parser:

- **A UTF-8 byte-order mark hid a note's entire frontmatter block** — including
  a `tags:` entry that may have been its only exclusion marker. A BOM is
  invisible but is a real character at offset 0, so `^---` never matched. The
  same miss cost the note its first heading (`^#`). Windows editors, PowerShell
  redirection and several export tools emit one routinely.
- **An unterminated frontmatter block discarded its `tags:` list.** A truncated
  write or a sync conflict was enough to trigger it, and since those tags carry
  no `#`, nothing was left for the inline pattern to find. Such a block is now
  scanned for tags, bounded so it stops once the content stops looking like
  frontmatter — a blank line is neutral and a YAML comment never ends the
  block, while an indented line extends it only after a real `key: value` has
  established that the block is YAML at all. That bound took three attempts:
  the first two over-corrected, once into reading a whole prose document as
  YAML and once into dropping tags that sat behind a comment. Every shape is
  now pinned by its own test rather than as a group.
- **An inline tag was only recognized after whitespace or `(`**, so any other
  punctuation in front of it dropped the tag: `**#private**` (bold — an
  ordinary way to write one), `urgent,#private,todo`, and `"#private"` all
  extracted nothing. The rule is now stated as what a tag may *not* follow,
  which also fixed a live false positive — `[text](#section)` used to register
  `section` as a tag.

Other hardening:

- **`scripts/install.sh` now fails closed.** Checksum verification degraded to
  a printed note and installed anyway when the `SHA256SUMS` manifest could not
  be fetched, or when no sha256 tool was found. Whoever can tamper with
  `main.js` in transit can equally make one request fail, so an absent manifest
  is indistinguishable from interference. Both paths now refuse;
  `--skip-verify` is the explicit opt-out for releases before v0.6.0, which
  predate the manifest. Tool detection uses `command -v` rather than running a
  tool against downloaded data, and a plain-`http://` asset source is called
  out as unprotected.
- A session note's filename stem is resolved via `resolveInVault` rather than
  concatenated; pending-inbox single-line fields also collapse U+2028/U+2029,
  which some Markdown renderers draw as a line break; a stored (uncompressed)
  ZIP entry's real byte length is checked against the decompression cap, not
  just its declared size; and a whitespace-only provider config degrades to
  lexical immediately instead of failing on first request. None were reachable
  through a live path — each is closed as defense in depth.
- The failed-auth lockout survived a server restart, so an attacker could lock
  the owner out and rotating the token — the recovery the UI offers — did not
  clear it. A real rebind now resets the window.

### Fixed

- **An index-version bump forced a full re-embed of the whole vault.** The
  vector cache was loaded only when the chunk index loaded *successfully*, so
  any `INDEX_VERSION` mismatch — which 0.11.1's own bump caused for every
  existing user — started from an empty store and treated every chunk as new.
  Vectors are keyed by chunk id and content hash and gated on provider
  identity, so they were always safe to reuse across a rebuild. On a paid
  embedding provider this was real money charged on upgrade for text that had
  not changed.
- **Hybrid search then silently degraded to lexical.** Loading the vector cache
  unconditionally was only half the fix: the retriever built before that load
  stayed frozen on an empty vector map, so search returned lexical-shaped
  scores while the reported mode still said "hybrid". It never self-healed,
  because the embedding pass only rebuilds the retriever when it changed
  vectors — and on that path every vector is reused.
- **A settings change landing mid-pass could silently discard an entire
  reindex.** `updateSettings` runs off the engine's index chain and replaces the
  index manager outright on a memory-root change; because `build`/`refresh`
  yield to the event loop, the code resuming afterwards could reach a fresh,
  empty manager where `persist()` returns silently. The completed build was
  thrown away while the log reported success. Index, embedding and attachment
  passes now bind the objects they started with.
- **A blank entry in Excluded folders silently excluded the entire vault.** An
  empty folder key matches every path, and the exclusion list — unlike the
  inclusion list — did not drop blanks. Reachable from a hand-edited
  `data.json` or a restored settings backup.
- **A new memory could be silently dropped as a "duplicate".** The inbox dedup
  cache added in 0.11.1 relied on the inbox file's mtime moving whenever
  something else changed it. Mtime resolution is coarse on some filesystems, so
  a discard followed immediately by a proposal could land in the same tick and
  the stale cache reported a genuinely new memory as already pending. Apply and
  discard now clear the cache outright.
- **A `folder` search filter and an Excluded folders entry normalized
  differently**, so `./Notes` correctly excluded a folder but matched nothing as
  a filter — zero results, indistinguishable from "nothing matched". Both now
  share one normalizer.
- `summarize_note`'s sentence splitter treated every abbreviation's period
  ("Dr.", "U.S.", "etc.") as a sentence boundary, so fragments like "S." could
  be surfaced as a "sentence" — breaking the module's promise that a summary is
  only ever the note's own sentences.
- A note ending in a newline gave its last chunk an `endLine` one past the end,
  so "open at line" and `get_note_context` landed just past the content.
- A JSON-RPC request carrying an `id` that is not a valid id (`null`, a
  boolean, an object, `NaN`) was treated as a notification and given no
  response at all, leaving the client waiting forever.
- A memory-root change did not reset the one-shot attachment-cache-clear flag,
  so a stale extracted-attachment cache at the new root was never pruned.
- A memory file that exists but cannot be read was treated as empty with no
  log, indistinguishable from one that was never created.

### Changed

- **The plugin no longer claims an embedding update it did not perform.** Every
  failure in an embedding pass is non-fatal by design — retrieval degrades to
  lexical — so they all reached the UI indistinguishable from success: a user
  whose Ollama simply was not running was told "Embeddings updated" and could
  only learn otherwise by opening devtools. A pass now reports its outcome and
  the notice says what happened and what to check.
- **Search distinguishes "nothing is indexed" from "nothing matched."** Nothing
  indexes automatically on install, so an empty index is the expected first-run
  state and the likeliest reason a new user sees no results.
- The `search_vault_memory` description sent to the calling agent claimed
  results are "de-duplicated so the same memory isn't returned twice".
  Near-duplicate collapsing and per-note capping are opt-in and **off by
  default**, so that promised something the default configuration does not do.
- The **Discard** button in the review UI is styled as the destructive action
  it is, and clearing the edit box then clicking Apply no longer does nothing
  in silence.
- Shared helpers replace drifted duplicates: `normalizeFolder` and
  `foldForCompare` in `utils/text.ts`, the sharding rules in `utils/sharding.ts`,
  one `MEMORY_TYPES` list, and `ObsidianHttpClient` now uses the shared
  `withTimeout` guard rather than a third copy of the same race.

### Tests

634 → 672. Every fix above is covered by a test confirmed to fail without it.
Two of those tests were themselves found defective during the cycle and
repaired — one passed vacuously because its `PATH` stopped `bash` from
resolving, and one used a tautological predicate that exercised the wrong
branch. Both are recorded here rather than quietly corrected.

- `ObsidianVaultAdapter.write`'s temp-file → backup → rename dance, whose whole
  purpose is that a failed write is never a destructive one, had **no unit
  coverage** — it was reachable only from the e2e harness, which needs a real
  Obsidian install and does not run in CI. Fault-injection tests now drive the
  real adapter; 3 of the 5 fail against a naive delete-then-write.
- The layering guard now detects a host/Node dependency in every form that
  creates one — single- or double-quoted, `require()`, dynamic `import()`, and
  a bare builtin — not just double-quoted `from "node:`.
- Sharded-index corruption tests asserted only that `load()` returned `null`;
  they now rebuild and verify the affected note comes back.

## [0.11.1] — 2026-08-24

A hardening release: four review passes over the subsystems 0.11.0's sharded
persistence work did not touch, plus the two source findings from Obsidian's
automated 0.11.0 review. **Tag extraction failed open in two ways, so the index
rebuilds once on upgrade.**

### Security

Tags are a privacy control — `excludedTags` is what keeps a note out of the
index and away from the local MCP server — so a tag the parser misses means the
note is indexed and served despite being excluded. Two such misses, the same
fail-open shape as the 0.10.4 and 0.9.9 bugs:

- **An inline tag was only recognized after whitespace or `(`**, so any other
  punctuation in front of it dropped the tag entirely: `**#private**` (bold —
  an ordinary way to write one), `urgent,#private,todo`, and `"#private"` all
  extracted nothing. The rule is now stated as what a tag may *not* follow (a
  word character, a `/`, or a markdown link's `](`), which keeps the
  URL-fragment guard the old narrow pattern provided by accident and
  additionally fixes a live false positive: `[text](#section)` used to register
  `section` as a tag.
- **An unterminated frontmatter block discarded its `tags:` list**, and since
  those tags carry no `#`, nothing was left for the inline pattern to find. A
  truncated write or a sync conflict was enough to trigger it. Such a block is
  now scanned for tags to end-of-file; its content still counts as body, so
  nothing is hidden from the index by the change.
- `INDEX_VERSION` is raised to 4. Fixing a parser only changes what happens on
  the next *read* of a note, and a refresh re-reads only when the mtime
  changed — so the bump is what actually evicts notes that should never have
  been indexed. **Expect one automatic rebuild.**

Other hardening, none of it reachable through a live path today — each closed
as defense-in-depth:

- A session note's filename stem (`ProjectMemory.startSession`) is resolved
  against its sessions folder via `resolveInVault` instead of concatenated, so
  a stamp containing `..` cannot write outside the project's session folder.
- Pending-inbox single-line fields (`Source`, `Origin`, tags, related paths)
  also collapse U+2028/U+2029 (LINE/PARAGRAPH SEPARATOR), which some Markdown
  renderers draw as a hard break — an agent-supplied field containing one could
  otherwise render as a spoofed extra line in the review UI. The file and the
  parser were never affected.
- ZIP stored (uncompressed) entries check their actual byte length against the
  decompression-bomb cap, not just the central directory's declared
  `uncompressedSize`; the two can differ for a crafted entry. The upstream
  50 MB attachment cap already bounds any archive today.
- A local-provider config (Ollama endpoint/model, OpenAI-compatible
  endpoint/model/API key) with a missing *or whitespace-only* value degrades to
  lexical retrieval immediately with a logged reason, instead of building a
  provider that only fails once a request is actually made.
- Ollama / OpenAI-compatible availability checks log the HTTP status on a
  non-2xx response. A wrong API key previously degraded retrieval to
  lexical-only indefinitely with nothing distinguishing it from "the endpoint
  isn't running yet."
- `version-bump.mjs` refuses a version that moves backward or sideways, and
  parses both `manifest.json` and `versions.json` before writing either, so a
  malformed `versions.json` fails closed rather than leaving the manifest
  bumped and `versions.json` stale.
- The release workflow's `versions.json` lookup passes the tag name through
  `env:` instead of splicing it into a `node -p` string literal.
- `package.json` gained `"private": true`: nothing in the pipeline publishes to
  npm, and an accidental manual `npm publish` is now refused.

### Fixed

- A note ending in a newline gave its last chunk an `endLine` one line past the
  end, because splitting on newlines produces a trailing empty element that is
  not a line. Only the final chunk of a note was affected, and only when its
  section fit in a single chunk — the common case — so "open at line" and
  `get_note_context` landed just past the content.
- `summarize_note`'s sentence splitter treated every abbreviation's period
  ("Dr.", "U.S.", "etc.") as a sentence boundary, so fragments like "S." could
  be selected and surfaced verbatim as a "sentence" — a real break of the
  module's stated promise that a summary is only ever the note's own sentences.
- Search's `folder`/`project`/`tag` filters are case- and Unicode-form
  insensitive, matching the fold vault-scan exclusions already used. A filter
  typed as `notes`, or in a different accent normalization form, no longer
  silently returns zero results.
- A memory-root change (`updateSettings`) did not reset the one-shot
  attachment-extraction-cache-clear flag, so a stale, possibly sensitive
  extracted-attachment cache found at the new root (a reused or restored
  folder) was never pruned even with attachment indexing off there too.
- The embedding worker pool captured the first batch failure into an `unknown`
  and rethrew it verbatim, so a provider rejecting with a non-`Error` (a
  string, a raw response object) propagated that value to callers that all
  treat a failure as an `Error`. *(Obsidian 0.11.0 review.)*
- Vault scanning snapshots `excludedTags` once per scan, as the folder and
  pattern filters already did, instead of reading the settings array live on
  every file.

### Performance

- `add_memory` no longer re-reads and re-parses the whole review inbox on every
  call to check for duplicates. That was O(inbox), and the inbox grows with
  agent usage rather than vault size, so an unreviewed backlog slowed every
  later proposal. Dedup keys are cached against the inbox file's mtime; an
  apply, a discard, or a hand-edit in Obsidian moves the mtime and forces a
  re-parse, so the cache cannot go stale.

### Changed

- `MemoryType`'s value list is exported once (`MEMORY_TYPES` in
  `memory-types.ts`) and imported by both the `add_memory` MCP tool and the Add
  Memory modal, instead of being hand-copied in each — a new memory type can no
  longer be added to one and silently missed by the other.
- Settings-tab warning Notices (embedding provider choice, server host,
  non-localhost binding, direct writes) are raised through one shared method on
  both the declarative and imperative code paths.
- The case/Unicode-fold helper used by search filtering and vault-scan
  exclusions lives once, in `src/utils/text.ts`.
- Removed a redundant `Math.min`/`Math.max` clamp around two MCP `limit`
  arguments already range-validated by `optionalNumber` (which throws rather
  than silently clamping).
- The one `eslint-disable` in the repo that shipped without a `--` rationale
  now carries one. *(Obsidian 0.11.0 review.)*

### Tests

608 → 634. The three privacy and correctness fixes above were each confirmed to
fail without their fix.

- The MCP tool surface is asserted as an exact set rather than with
  `toContain`. The invariant is what is *absent* — promotion is UI-only and
  there is no generic file access — and a containment check keeps passing when
  a tool is added, which is precisely the change that would breach it.
- The layering guard detects a host/Node dependency in every form that creates
  one: single- or double-quoted, `require()`, a dynamic `import()`, and a bare
  builtin (`from "fs"`, not just `"node:fs"`). Nothing in the tree was
  violating it, but the guard was checking formatting as much as substance. A
  meta-test now pins the matcher itself.
- `migrateSettings` on a garbage blob is asserted to return the safe defaults,
  not merely to avoid throwing — the outcome that matters, since callers read
  `server.enabled` and friends straight off the result.
- `summarize_note`'s documented fail-open now covers the case that was
  untested: a provider that passes its liveness check and then throws mid-call.

## [0.11.0] — 2026-08-23

### Added

- Size-adaptive index persistence: past ~20k chunks the chunk index persists as
  256 shard files (routed by note-path hash) instead of one monolithic
  `chunks.json`, so an edit rewrites ~1/256 of the corpus; the embeddings cache
  mirrors this past ~20k vectors (a vector-less manifest plus vector shards),
  and embedding checkpoints rewrite only the shards they touched. Small vaults
  keep the classic single-file layout byte-for-byte; hysteresis keeps
  boundary-sized vaults from flip-flopping; layout switches blank obsolete
  files to sentinels (the adapter has no delete). A corrupt chunk shard forces
  a rebuild; a corrupt embedding shard drops only its own vectors.
- `IndexManager.build`/`refresh` yield to the host event loop every 500
  re-chunked notes, so a large first index or rebuild can no longer freeze the
  Obsidian UI.

### Security

- Local server: after 10 failed authentications within 60 s every request is
  refused (`429`) until the window drains, so a network-exposed token cannot be
  guessed at wire speed (the constant-time compare only closed the timing
  channel). Binding a non-localhost host now also requires a token of at least
  16 characters. The HTTP server sets explicit socket timeouts (15 s headers,
  30 s request, 5 s keep-alive idle) instead of relying on Node's minutes-long
  defaults, and rejected-request log lines truncate the attacker-controlled
  `Host`/`Origin` value.
- Dev-only dependency advisory GHSA-2v37-7h3g-55p8 (`nanoid` via
  vitest→vite→postcss) resolved by lockfile bump to 3.3.18; `nanoid` is not part
  of the shipped bundle.

### Fixed

- Sharded chunk index: a missing shard file is now treated as damage (rebuild),
  not as "no notes here". Loading it as empty was permanent — the note's
  recorded mtime said "unchanged", so no refresh ever re-chunked it — and
  silently removed those notes from search.
- Sharded chunk index: a layout switch now writes the new layout's data, then
  the metadata naming it, and only then blanks the obsolete file. The previous
  order could leave metadata naming a file already blanked to `[]`, which a
  crash in that window turned into a valid, empty index. Dirty-shard marks are
  snapshotted before writing so a shard dirtied mid-persist is not dropped.
- Embedding store: a persist that failed once (for example a transient
  checkpoint write error) rejected every later persist without running it,
  silently ending persistence for the session; the chain now continues after a
  failure. A stored vector whose base64 decodes off a 4-byte boundary is
  rejected at load instead of throwing `RangeError` out of retriever
  construction at startup.
- Engine: `reindex`/`refresh` are serialized on one promise chain (as embedding
  passes already were). `IndexManager.build`/`refresh` now yield mid-pass, so
  the auto-index debounce, a settings-triggered refresh, and the `reindex_vault`
  tool could otherwise interleave and mutate one index concurrently.

### Performance

- Sharded persist groups only the chunks whose shard will be written; sharded
  load reads the 256 shard files concurrently instead of one at a time.

### Changed

- The sharding rules (shard count, routing hash, hysteresis, shard file naming)
  move to `src/utils/sharding.ts`, shared by the chunk index and the embedding
  store so the two caches cannot drift apart.

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

[Unreleased]: https://github.com/nfoav8or/coder-engram/compare/0.14.1...HEAD
[0.14.1]: https://github.com/nfoav8or/coder-engram/releases/tag/0.14.1
[0.14.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.14.0
[0.13.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.13.0
[0.12.1]: https://github.com/nfoav8or/coder-engram/releases/tag/0.12.1
[0.12.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.12.0
[0.11.4]: https://github.com/nfoav8or/coder-engram/releases/tag/0.11.4
[0.11.3]: https://github.com/nfoav8or/coder-engram/releases/tag/0.11.3
[0.11.2]: https://github.com/nfoav8or/coder-engram/releases/tag/0.11.2
[0.11.1]: https://github.com/nfoav8or/coder-engram/releases/tag/0.11.1
[0.11.0]: https://github.com/nfoav8or/coder-engram/releases/tag/0.11.0
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
