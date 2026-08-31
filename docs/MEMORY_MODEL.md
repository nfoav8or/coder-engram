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

## The rejection ledger

Discarding a proposal in the review modal records it in
`Memory/Inbox/rejected-memory.md` before removing it from the inbox, together
with the reason you type at the prompt (optional; cancelling the prompt cancels
the discard). The ledger exists because a discard used to leave no trace, and an
agent cannot tell "you rejected this" from "nobody has looked yet" — so its only
rational move was to keep proposing, and the same facts came back session after
session.

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
