# Memory model

Claude Code Engram stores all plugin-managed memory as Markdown inside the active vault, under a configurable root (default `Claude Code/`). Markdown is the durable source of truth; the JSON files under `Index/` are a rebuildable cache and never the only copy of your memory.

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
| `tags` | string[] | Extra tags; `#claude-code-engram` is always added. |
| `relatedPaths` | string[] | Related note/file paths. |
| `timestamp` | number | ms since epoch. |

## Pending-memory block format

By default, every proposed entry is appended to `Memory/Inbox/pending-memory.md` as a reviewable block (`formatMemoryEntry` in `src/memory/memory-writer.ts`). If the inbox file does not exist yet, it is created with a short header first. Example block:

```markdown
## Pending Memory: 2026-07-03 14:22

Type: decision
Project: ExampleProject
Source: Claude Code
Confidence: medium
Tags: #claude-code-engram #decision

Content:

We decided to use a local-first JSON index for v1 and abstract the vector store behind an interface.

Related files:

* docs/architecture.md
* src/indexer.ts

Status: pending

---
```

`Project`, `Origin`, `Confidence`, and the `Related files` list are only emitted when present. The `Tags` line always begins with `#claude-code-engram`. You review these blocks in the vault (or via **Review Pending Memory**) and apply or discard them by hand.

## Markdown as source of truth

The files under `Index/` (`chunks.json`, `metadata.json`, `embeddings.json`) are a derived cache built from your Markdown. They can be deleted and rebuilt at any time via **Reindex Vault** without losing memory. `embeddings.json` is written as an empty shell (`{ "model": null, "dim": 0, "vectors": {} }`) until an embedding provider is configured, and is populated with cached vectors once one is. See [RAG_PIPELINE.md](RAG_PIPELINE.md).
