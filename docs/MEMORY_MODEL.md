# Memory model

Coder Engram stores all plugin-managed memory as Markdown inside the active vault, under a configurable root (default `Claude Code/`). Markdown is the durable source of truth; the JSON files under `Index/` are a rebuildable cache and never the only copy of your memory.

## Folder tree

```
Claude Code/                         (memory root; configurable, must stay in the vault)
  Memory/
    Global/                          global memory (project-agnostic)
      profile.md
      preferences.md
      conventions.md
    Projects/
      <project-name>/                one folder per project
        overview.md
        architecture.md
        decisions.md
        tasks.md
        open-questions.md
        sessions/
          YYYY-MM-DD-HHMM.md         one file per session
    Inbox/
      pending-memory.md              append-only review inbox
      rejected-memory.md             ledger of discarded proposals (capped)
      superseded-memory.md           ledger of memories retired by a later one
  Index/                             rebuildable cache (not source of truth)
    chunks.json
    metadata.json
    embeddings.json
  Config/
    plugin-settings-backup.json
```

The layout is defined by `resolveMemoryPaths` in `src/memory/memory-types.ts`. Note that `Memory/`, `Index/`, and `Config/` are all siblings directly under the root: `Global`, `Projects`, and `Inbox` live under `Memory/`, while `Index/` and `Config/` sit at the root level. Every path in this tree is produced through `resolveInVault`, so a misconfigured subfolder that would escape the root throws rather than writing outside it.

Scaffolding is non-destructive: template files are created only if missing and are never overwritten, so your edits are always preserved.

## Global vs project vs session memory

- **Global memory** (`Memory/Global/`) is project-agnostic. `profile.md` (who you are and your working context), `preferences.md` (how you like to work), and `conventions.md` (standards to follow). `MemoryStore.getGlobalContext()` concatenates these.
- **Project memory** (`Memory/Projects/<name>/`) is per-project. `overview.md`, `architecture.md`, `decisions.md`, `tasks.md`, and `open-questions.md`. `MemoryStore.getProjectContext(name)` concatenates them in that order. Project names are sanitized to a single safe folder segment (`sanitizeProjectName`).
- **Session memory** (`Memory/Projects/<name>/sessions/`) is one Markdown file per working session, named by timestamp (`YYYY-MM-DD-HHMM.md`). "Start Session Note" creates a file with Goals / Notes / Outcomes headings; "End Session Note" appends a closing summary.

## MemoryEntry metadata

A proposed memory (from the Add Memory command, or from the server) is modeled by `MemoryEntry` (`src/memory/memory-types.ts`):

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `decision` \| `note` \| `task` \| `open-question` \| `action-item` \| `preference` \| `architecture` \| `session` | Kind of memory. |
| `content` | string | The memory body. |
| `project` | string (optional) | Associated project name. |
| `source` | string | Where it came from, e.g. `Obsidian UI`, `Claude Code`. Defaults to `Obsidian UI`. |
| `originTool` | string (optional) | Originating command or MCP tool. |
| `confidence` | `low` \| `medium` \| `high` (optional) | |
| `tags` | string[] | Extra tags; `#coder-engram` is always added. |
| `relatedPaths` | string[] | Related note/file paths. |
| `timestamp` | number | ms since epoch. |

## Pending-memory block format

By default, every proposed entry is appended to `Memory/Inbox/pending-memory.md` as a reviewable block (`formatMemoryEntry` in `src/memory/memory-writer.ts`). If the inbox file does not exist yet, it is created with a short header first. Proposals are **de-duplicated**: an entry whose content, type, and project match one already pending is not appended again (the caller is told it is already pending), so a looping agent cannot flood the inbox with repeated proposals. Content is matched after collapsing whitespace, folding case, and normalizing Unicode form to NFC, because an agent re-proposing a fact across sessions rarely reproduces its own wording byte-for-byte — and the same accented words arrive decomposed when they came from a path or filename read on macOS, composed when typed or pasted elsewhere. Those two encodings render identically, so without normalizing them the reviewer sees two cards that look the same with no way to tell why both are there. That is still an **exact** comparison of the words themselves, deliberately not a fuzzy one: a restatement that adds genuine detail is a different memory and is kept, since suppressing it would lose information permanently, while a duplicate costs the reviewer one dismissal.

Reading the inbox is cached too, against the file's mtime — `readInbox` used to
re-read and re-parse the whole file on every call, so checking what is pending
and then proposing parsed it twice, and the review UI parsed it again after
every action. That cache and the two ledger caches share one `FileDerivedCache`
with a single stated rule: a null mtime means nothing to read, and the writer
seeds or clears explicitly after its own writes rather than trusting the mtime
to have moved.

Apply and discard clear it **after** the write as well as before. `readInbox`
runs outside the inbox lock on purpose, so a read landing in between caches the
pre-write parse — and on a filesystem whose mtime does not move between those
two writes, nothing would clear it again.

The dedup check does not re-read and re-parse the whole inbox on every proposal. That cost is O(inbox), and the inbox grows with how much the agent proposes rather than with vault size, so a backlog left unreviewed made every later `add_memory` slower. The parsed dedup keys are cached instead, and invalidated two ways, because neither alone is sound. The writer clears the cache outright whenever *it* rewrites the inbox (an apply or a discard). Everything else — a hand-edit in Obsidian, another tool touching the file — is caught by comparing the file's **mtime** against the one the cache was built from. Relying on mtime alone was a real bug, not a theoretical one: mtime resolution is coarse on some filesystems, and a discard followed immediately by a proposal can land in the same tick, so a surviving cache would report a genuinely new memory as a duplicate and silently drop it. The two layers together mean the cache cannot outlive a change it did not make. One key function serves both the cache and the comparison it replaces, so the two cannot drift apart on what "the same memory" means. Example block:

```markdown
## Pending Memory: 2026-07-03 14:22

Type: decision
Project: ExampleProject
Source: Claude Code
Confidence: medium
Tags: #coder-engram #decision

Content:

We decided to use a local-first JSON index for v1 and abstract the vector store behind an interface.

Related files:

* docs/architecture.md
* src/indexer.ts

Status: pending

---
```

`Project`, `Origin`, `Confidence`, and the `Related files` list are only emitted when present. The `Tags` line always begins with `#coder-engram`. Structural look-alikes inside `Content` are neutralized at render time with one leading space: a line starting with `## Pending Memory: ` (which would forge a second entry), and — only when the entry has no real related-files list — a content tail shaped exactly like a `Related files:` section (which the parser could not otherwise tell apart from structure; see SECURITY.md). You review these blocks in the vault (or via **Review Pending Memory**) and apply or discard them by hand.

## Memory ageing

Every memory used to be equally true forever, so a decision from eighteen months
ago outranked last week's on term frequency alone. Recency existed only as a
filter (`sinceDays`), which is all-or-nothing.

**Memory ageing (half-life in days)** — `memoryDecayHalfLifeDays`, 0 to disable,
off by default — multiplies a memory's retrieval score by
`0.5 ^ (ageDays / halfLife)`, floored at 0.25.

- **Memory only.** Ordinary notes are documents, not claims that go stale. The
  test is `isInsideRoot(paths.memory, notePath)`, and an unparseable path is
  simply not memory, leaving it undecayed.
- **Floored.** A memory you cannot retrieve is a memory you have lost. At the
  floor an aged memory still outranks anything it beats by more than 4× on
  relevance — the difference between "older, so lower" and "old, so gone".
- **Dated per memory, not per file.** The age comes from the timestamp
  `formatAppliedBlock` writes into the heading, falling back to the file's mtime
  only when there is none. Dating by mtime alone would make adding one decision
  refresh every older decision in the same file; decay that resets itself is
  worse than none, because it looks like it works.
- **Applied last, in the engine.** It multiplies a score that does not exist
  until the retriever has produced one, so there is no earlier place for it. It
  sits in `EngramEngine.search` rather than in the retrievers because all three
  would otherwise carry the same re-weighting, along with the settings and clock
  dependencies they are deliberately free of. (The supersession filter running
  just before it is post-ranking for a different reason: it *removes* chunks,
  and doing that pre-scoring would move the BM25 statistics.)
- **A future date scores 1, never more.** Clock skew and hand-typed headings both
  produce those, and a wrong date must not become a way to win every ranking.

A corrupt or missing value degrades to 0 (off) rather than failing settings
load: the setting only reorders results, so degrading it can lose nothing. The
type check is explicit rather than a bare `Number(value)` — that would turn `[5]`
into `5`, and an object with a `valueOf` into whatever it returns, so a corrupt
blob could silently switch a ranking feature *on*, which is not what "degrades to
a safe default" means. A numeric string is still accepted, because a hand-edited
`data.json` is an ordinary way to reach this.

## Overlap at propose time

Dedup answers "is this the same memory?" — exactly, and only. Nothing answered
"is there already a memory about this?", so a proposal that changed a recorded
fact landed beside the old one and retrieval returned both, with nothing to say
which was current.

Every proposal is now scored against memory-root chunks by **term containment**:
the share of the proposal's own distinct terms that also appear in an existing
memory, thresholded at 0.6. Containment rather than Jaccard, because a two-line
proposal about the same decision as a long-standing memory should match it, and
Jaccard punishes that pairing for the length difference alone. Proposals under
four terms are skipped — any ratio there is a coin flip, and a false "this
already exists" invites suppression, which is the worse error.

The strongest match is written to the block as `Similar: <path>#<heading>`,
returned to the agent, and shown on the review card. It is **reported, never
acted on**: deciding that two memories disagree is not something an offline
check can do, so it names the candidate and the one action that resolves it —
re-propose with `supersedes` if this replaces the old memory, leave it as
proposed if it only adds detail.

The check sits in a write path, so it is bounded accordingly: no query embedding
(the retriever degrades to its lexical component without one), and any failure
yields "no overlap" rather than failing the proposal. Pending proposals and the
ledgers are excluded — overlapping something nobody has approved is not news,
and `supersedes` cannot name something that is not memory yet. The field is
engine-computed and has no schema entry: it is an observation about the vault,
not a claim the proposer gets to make.

It is also skipped entirely on a **direct write**. The annotation exists to be
read at review time, and a direct write has no review — writing it there would
leave a permanent `Similar:` line in a memory file nobody was given the chance to
act on, which is reporting turned into an unreviewed edit.

## Superseding a stale memory

Memory used to be write-once. Dedup deliberately keeps a restatement that adds
detail, so contradictory entries accumulated and nothing could ever be retired —
and a stale memory is worse than none, because it still reads as settled
knowledge.

A proposal may carry a `Supersedes: <path>#<heading>` field naming the memory it
replaces. The reference is exactly what a search result already prints, so an
agent that found the stale memory has it to hand; a full `A › B › C` heading path
is accepted and its leaf taken.

Two rules bound what may be named, checked at `add_memory` (so an unusable
reference never reaches the inbox) and re-checked at apply (because the inbox is
a file a person can edit in between):

- **Inside the memory root.** Retiring is a hide, so a reference able to name any
  vault note would let a proposal quietly suppress the user's own writing.
- **A heading is required.** A bare path would retire a whole file in one click.

Applying the entry appends a record to `Memory/Inbox/superseded-memory.md`.
Nothing is overwritten — that is what lets superseding coexist with the
apply-is-always-an-append rule. From then on:

- `search` drops results in the retired section. The filter runs **after**
  ranking, never before: removing the chunks first would change the BM25 corpus
  statistics every other result is scored against, so retiring one memory would
  silently re-rank unrelated notes.
- `get_project_context` and `get_global_context` replace the section with a
  `— superseded` marker and a pointer to the ledger. Without this the retired
  text would still be served through the other door, beside its replacement,
  with nothing to tell them apart.
- `get_note_context` and `summarize_note` read a note's chunks, and both go
  through `EngramEngine.getReadableNoteChunks`, which drops retired sections.
  Every path that hands chunk *text* to a caller goes through that one method;
  the raw `getNoteChunks` stays unfiltered because its other callers ask an
  existence question ("is this note indexed?"), which a retirement does not
  change. A note whose every section is retired reports exactly that, rather
  than the "not indexed" answer that would send an agent to reindex it.

Section boundaries come from `scanMarkdownLines`, the chunker's own heading
scan, so a section is retired on exactly the boundaries it was chunked on. A `#`
comment inside a code block is not a heading, and a closing fence must match the
marker that opened it.

Five rules keep a retirement from taking more than it named, or less:

- **Applied content has its code fences balanced** before it is written. Content
  lands in the file verbatim, and an odd number of fence markers desynchronizes
  every fence-aware reader to the end of the file — which made one crafted
  memory able to hide every section applied after it. Closing the fence is
  additive and visible; nothing in the content is altered or removed.
- **Applied headings carry a short content-derived anchor** —
  `## Decision — 2026-07-03 14:22 · k3f9a1`. The heading is the address a
  reference names, and `timestampLabel` has minute granularity: a reviewer
  applying several same-type entries in one minute produced byte-identical
  headings, so retiring one retired the other. Two entries that agree on content
  as well are the same memory, which the inbox dedup already refuses.
- **An ambiguous target retires nothing.** If the named heading matches more
  than one section — possible in a file written before the anchor existed, or
  hand-authored — the apply reports `ambiguous` and retires neither. Removing a
  memory nobody named is the one harm this mechanism must never cause.
- **Headings inside applied content are nested below the block's own.** A
  section ends at the next heading of the same or a shallower level, so a plain
  `## ` line in the content ended the block early: retiring that memory removed
  the text above the line and left everything below it being served, while the
  apply reported `recorded` and the reviewer was told the memory was retired.
  The content's headings are demoted rather than neutralized, so the author's
  structure survives as structure, nested under the block it was describing.
  Same shape as the fence rule above, one door further along.
- **A reference is keyed by its canonical path.** The in-root check normalizes
  both sides before comparing, so a reference carrying a dot segment
  (`…/Global/./profile.md`) validated — but the retirement was then recorded
  under the string as typed, while every consumer builds its key from a real
  note path. The record existed, reported `recorded`, and matched nothing: the
  memory kept being served indefinitely. The parser now returns the canonical
  path, which repairs the reading side of ledgers already on disk, since both
  sides go through it.

Delete a record from the ledger to bring that memory back. Unlike the rejection
ledger, this one is **not capped**: dropping the oldest record would silently
un-retire a memory the reviewer replaced, putting stale text back into search —
the exact failure superseding exists to fix.

Retiring is **human-gated**. `supersedes` on a proposal is a claim; nothing in
the MCP tool surface can promote it. The review card names the memory that will
be retired, above the content, so approving it is never a surprise. If the
reference no longer resolves at apply time the apply still succeeds — the new
memory is what the reviewer approved — and the UI says plainly that nothing was
retired.

## The rejection ledger

Discarding a proposal in the review modal records it in
`Memory/Inbox/rejected-memory.md` before removing it from the inbox, together
with the reason you type at the prompt (optional; cancelling the prompt cancels
the discard). The ledger exists because a discard used to leave no trace, and an
agent cannot tell "you rejected this" from "nobody has looked yet" — so its only
rational move was to keep proposing, and the same facts came back session after
session.

**The ledger is not a search result.** It lives in the vault and is indexed like
any other note, so until this was fixed the refused claim came back through
`search_vault_memory` as an ordinary unlabelled hit — and its structured record
reported `pendingReview: false`, asserting it was reviewed memory. That inverts
the point of the whole mechanism: the ledger exists so an agent stops
re-proposing what was refused, not so a refusal becomes searchable knowledge.
Both ledgers are excluded from search results and are read through
`list_rejected_memory`, which labels them and carries your reason. The
**pending** file is deliberately different: it stays searchable and stays
labelled `[PENDING REVIEW]`, because an agent seeing its own proposals is the
feature `list_pending_memory` was added for.

Records reuse the pending-block format with a `## Rejected Memory: ` heading, a
`Reason:` field and `Status: rejected`, so there is still exactly one producer of
the on-disk shape and the ledger round-trips through the same parser. Content
carrying a `## Rejected Memory: ` line is neutralized when the **proposal** is
rendered, not when the record is: such a line is inert in the inbox and only
becomes structural once the proposal is copied into the ledger.

While a record stands, an identical proposal is refused and `add_memory` reports
the rejection *with its reason*. "Identical" is the same exact content/type/
project identity the inbox dedup uses — a proposal that rephrases or adds real
detail is a different memory and still gets through, so one rejection cannot
silently swallow every later version of the same fact.

Three things undo a rejection:

- **Clear rejections** in the review modal empties the ledger.
- Deleting one record by hand un-rejects just that memory (the key cache is
  mtime-checked against the file, so a hand edit takes effect on the next
  proposal).
- Adding the same memory yourself through **Add memory** overrides your earlier
  rejection and drops the stale record with it — the same person changing their
  mind.

The ledger is capped at 200 records; the oldest fall off, which simply makes
those memories proposable again. Writing the record is **best-effort**: the
inbox is rewritten first, so a failed ledger write loses only the feedback (and
says so) rather than failing the discard, and can never leave a record claiming a
still-pending entry was rejected.

## Markdown as source of truth

The files under `Index/` (`chunks.json`, `metadata.json`, `embeddings.json`) are a derived cache built from your Markdown. They can be deleted and rebuilt at any time via **Reindex Vault** without losing memory. `embeddings.json` is written as an empty shell (`{ "model": null, "dim": 0, "vectors": {} }`) until an embedding provider is configured, and is populated with cached vectors once one is. See [RAG_PIPELINE.md](RAG_PIPELINE.md).
