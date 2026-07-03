/ultraplan

/goal

Create a new production-capable, fully operational Obsidian plugin named `claude-code-engram`.

Display name: Claude Code Engram

Tagline:

An Obsidian-powered memory and RAG layer for Claude Code.

Primary goal:

Build a production-capable Obsidian plugin that turns the active Obsidian vault into a local-first memory, project context, and RAG backend for Claude Code.

This plugin should function like a durable memory layer for Claude Code. It should index Obsidian notes, retrieve relevant context, expose project-aware memory, and allow Claude Code to propose or write memory back into the vault in a safe, reviewable way.

Think of this as “claude-mem for Obsidian,” implemented as a real Obsidian plugin with production-grade architecture, strong local-first privacy defaults, secure MCP-style integration, reviewable write workflows, and clear documentation.

Repository/package name:

claude-code-engram

Obsidian plugin ID:

claude-code-engram

Display name:

Claude Code Engram

Primary memory root:

Claude Code/

The plugin-managed memory must live inside a top-level `Claude Code/` folder within the currently active Obsidian vault.

The plugin must never store memory outside the Obsidian-defined vault.

---

## Core product requirements

### 1. Obsidian plugin foundation

Create a complete Obsidian plugin using TypeScript.

The plugin must include:

* `manifest.json`
* `package.json`
* `tsconfig.json`
* esbuild or Vite build setup
* main plugin entrypoint
* settings tab
* command palette commands
* plugin styles if needed
* `README.md`
* `CHANGELOG.md`
* `LICENSE` placeholder
* development setup instructions
* production build instructions
* manual installation instructions

The plugin must build cleanly and load into Obsidian without errors.

Use production-oriented TypeScript conventions.

Avoid unnecessary dependencies.

Prefer simple, maintainable architecture over cleverness.

---

## 2. Required vault storage model

All plugin-managed memory must be stored inside the active Obsidian vault under:

Claude Code/

Default structure:

Claude Code/
Memory/
Global/
profile.md
preferences.md
conventions.md
Projects/ <project-name>/
overview.md
architecture.md
decisions.md
tasks.md
open-questions.md
sessions/
YYYY-MM-DD-HHMM.md
Inbox/
pending-memory.md
Index/
embeddings.json
chunks.json
metadata.json
Config/
plugin-settings-backup.json

Rules:

* The plugin-managed root defaults to `Claude Code/`.
* The root must resolve inside the active Obsidian vault.
* The plugin must reject any configured path that resolves outside the active vault.
* Normalize and validate all paths before reading or writing.
* Do not write memory to arbitrary filesystem locations.
* Do not use hidden external state as the primary memory store.
* Markdown files are the durable source of truth for human-readable memory.
* JSON index files may be used for retrieval performance.
* Index files are rebuildable and should not be treated as the only copy of memory.

Settings may allow users to rename or relocate subfolders inside `Claude Code/`, but the default production-safe assumption is that all plugin-managed memory lives under `Claude Code/`.

---

## 3. Claude Code memory concept

Claude Code Engram should allow Claude Code to use the Obsidian vault as a structured memory system.

The memory system should support:

* Project memory
* Global memory
* Session memory
* User preference memory
* Architecture/design memory
* Codebase decision memory
* Task history
* Open questions
* Action items
* RAG retrieval from vault notes

Memory should be stored in Markdown files inside the vault.

The plugin should make memory readable and editable by humans.

The system should avoid creating opaque lock-in.

---

## 4. RAG over Obsidian vault

Implement a local RAG pipeline over the Obsidian vault.

The plugin must:

* Scan Markdown notes
* Chunk notes into retrieval-friendly segments
* Track note path, heading, block position, modified time, tags, aliases, and links
* Build an index
* Refresh the index manually
* Refresh the index automatically when files change, if enabled
* Retrieve top relevant chunks for a query
* Return source paths and headings with results
* Support filtering by folder, tag, project, and recency
* Exclude folders configured by the user
* Exclude sensitive notes by configured path/tag patterns
* Avoid indexing binary attachments unless explicitly supported later

Use an abstraction layer for embeddings so the plugin can support multiple providers.

Initial embedding provider options:

* Local mock/hash embedding provider for development and tests
* Optional Ollama embedding provider
* Optional OpenAI-compatible embedding provider
* Optional Claude-compatible retrieval mode without embeddings using keyword/BM25 fallback

Do not hard-code one vendor as the only path.

The plugin must work without any cloud API key.

---

## 5. Retrieval modes

Implement at least two retrieval modes.

### A. Keyword/BM25-style retrieval

Use a local lexical search method that works immediately without API keys.

This should be the default mode for Milestone 1.

### B. Embedding retrieval abstraction

Create interfaces and storage models so vector search can be added or enabled cleanly.

The first production version may use a simple local vector similarity implementation over JSON-backed vectors, but the design must allow future migration to SQLite, LanceDB, DuckDB, or another local vector store.

---

## 6. MCP-compatible local server

Add an optional local MCP-compatible server mode so Claude Code can call the Obsidian memory plugin.

The MCP server should expose tools such as:

* `search_vault_memory`
* `get_project_context`
* `get_global_context`
* `add_memory`
* `propose_memory_update`
* `list_projects`
* `get_recent_sessions`
* `summarize_note`
* `get_decisions`
* `get_open_questions`
* `get_action_items`
* `reindex_vault`

The MCP integration must be designed safely.

Security requirements:

* Disabled by default
* User must explicitly enable it
* Bind to localhost by default
* Configurable port
* Optional token authentication
* Clear warning in settings before enabling
* No remote network binding unless explicitly configured
* No destructive file operations by default
* Writes should go to `Claude Code/Memory/Inbox/pending-memory.md` unless direct writes are enabled
* Direct writes require an explicit setting toggle
* Memory updates should be append-only by default
* Validate request payloads
* Rate-limit or debounce expensive operations where practical
* Do not expose arbitrary file read/write tools
* Do not expose full vault contents by default without query-scoped retrieval
* Log security-relevant events when debug logging is enabled, but never log secrets

If full MCP compatibility cannot be completed in the first pass, create the complete architecture, interfaces, and a working local HTTP JSON-RPC-compatible bridge as a stepping stone, then clearly document what remains for full MCP compatibility.

---

## 7. Claude Code integration docs

Create documentation showing how to connect Claude Code to Claude Code Engram.

Include:

* How to build the plugin
* How to install it into an Obsidian vault
* How to enable the local memory server
* How to configure Claude Code MCP settings
* Example MCP configuration
* Example Claude Code prompts
* Example memory workflow
* Example project bootstrap workflow
* Example RAG query workflow
* Example “write this decision to memory” workflow
* Security notes for local-only operation
* Safe defaults and risks of enabling direct writes

Include this file:

docs/CLAUDE_CODE_INTEGRATION.md

---

## 8. Plugin commands

Add useful Obsidian commands:

* Claude Code Engram: Open Control Panel
* Claude Code Engram: Reindex Vault
* Claude Code Engram: Search Memory
* Claude Code Engram: Add Memory
* Claude Code Engram: Add Current Note to Project Memory
* Claude Code Engram: Create Project Memory Folder
* Claude Code Engram: Show Project Context
* Claude Code Engram: Review Pending Memory
* Claude Code Engram: Start Session Note
* Claude Code Engram: End Session Note

---

## 9. UI requirements

Create a practical Obsidian UI.

Minimum UI:

* Settings tab
* Memory control panel view
* Search panel/modal
* Pending memory review panel/modal

Settings must include:

* Enable/disable plugin indexing
* Memory root path, defaulting to `Claude Code/`
* Included folders
* Excluded folders
* Excluded tags
* Project folder path under `Claude Code/Memory/Projects/`
* Auto-index on file change
* Embedding provider
* Embedding model
* MCP/local server enable toggle
* MCP/local server host
* MCP/local server port
* MCP/local server token
* Allow direct memory writes toggle
* Append-only writes toggle
* Debug logging toggle
* Security warning text for server mode
* Reset/rebuild index action

The settings UI should clearly communicate that the default memory root is inside the active vault.

---

## 10. Memory write safety

Implement memory writes carefully.

Default behavior:

* Claude Code or the local server can propose memory updates.
* Proposed updates are written to `Claude Code/Memory/Inbox/pending-memory.md`.
* User can review and apply them manually.
* Direct writes are disabled unless enabled in settings.
* Append-only mode is enabled by default.

Memory entries should include metadata:

* Timestamp
* Source
* Project
* Tags
* Confidence
* Origin command/tool
* Related note paths

Example pending memory format:

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

## 11. Architecture standards

Use clean, modular architecture.

Suggested source layout:

src/
main.ts
settings/
settings.ts
settings-tab.ts
ui/
control-panel-view.ts
search-modal.ts
pending-memory-modal.ts
indexing/
vault-scanner.ts
markdown-chunker.ts
index-manager.ts
metadata-extractor.ts
retrieval/
retriever.ts
lexical-retriever.ts
vector-retriever.ts
ranking.ts
embeddings/
embedding-provider.ts
mock-embedding-provider.ts
ollama-embedding-provider.ts
openai-compatible-provider.ts
memory/
memory-store.ts
memory-writer.ts
project-memory.ts
memory-types.ts
server/
local-server.ts
routes.ts
auth.ts
mcp-tools.ts
utils/
logger.ts
errors.ts
paths.ts
debounce.ts
validation.ts
tests/
fixtures/

Use interfaces wherever external provider behavior is involved.

Keep modules small.

Prefer simple testable functions.

Avoid mixing Obsidian UI code with retrieval/indexing logic.

---

## 12. Testing requirements

Add a test setup.

Use Vitest or another suitable TypeScript test runner.

Tests should cover:

* Markdown chunking
* Metadata extraction
* Index build
* Index refresh
* Lexical retrieval
* Memory write to pending inbox
* Settings defaults
* Path exclusion rules
* Path traversal rejection
* Rejection of memory paths outside the active vault
* Server auth token validation
* Tool request validation
* Safe default settings
* Disabled-by-default server behavior

Include test fixtures.

Add npm scripts:

* `npm run dev`
* `npm run build`
* `npm run test`
* `npm run lint`
* `npm run typecheck`

---

## 13. Production readiness

Make this production-capable, not just a prototype.

Include:

* Error handling
* Defensive file path handling
* Safe defaults
* Input validation
* Local-only default networking
* Settings migration support
* Logging with debug toggle
* No secrets committed
* No hard-coded API keys
* Clear user-facing error messages
* Graceful degradation when embedding providers fail
* Manual reindex fallback
* Reasonable performance on medium vaults
* Debounced indexing on file changes
* Atomic or safe writes where possible
* Reviewable memory writes
* Security-focused docs
* Clear limitations

---

## 14. Documentation requirements

Create complete docs.

`README.md` must include:

* What Claude Code Engram does
* Installation
* Manual installation
* Development setup
* Building
* Configuration
* Obsidian usage
* Claude Code usage
* Memory folder structure
* Security model
* Limitations
* Roadmap

Create docs:

* `docs/ARCHITECTURE.md`
* `docs/SECURITY.md`
* `docs/CLAUDE_CODE_INTEGRATION.md`
* `docs/MEMORY_MODEL.md`
* `docs/RAG_PIPELINE.md`
* `docs/MCP_SERVER.md`
* `docs/DEVELOPMENT.md`
* `docs/ROADMAP.md`

---

## 15. `/loop` and `/compact` review process

Enable `/loop` as a recurring review method throughout the project.

Enable `/compact` after each completed `/loop` cycle once simplification and security review findings have been addressed or explicitly documented.

The purpose of `/loop` is to improve the implementation.

The purpose of `/compact` is to preserve the current project state, decisions, risks, completed work, and next actions in a concise handoff summary before continuing.

Use `/loop` after each major milestone and after any security-sensitive implementation.

Use `/compact` between loops, after the security review is complete and all required high-severity fixes have been made.

Each `/loop` cycle must perform:

### 1. Simplification review

Look for:

* Over-engineered abstractions
* Unnecessary dependencies
* Duplicated logic
* Complicated control flow
* UI complexity that can be reduced
* Server features that should be delayed
* Indexing logic that can be made clearer
* Settings that can be grouped or simplified
* Anything that makes the plugin harder to maintain

Output:

* What can be simplified now
* What should remain as-is
* What should be deferred
* Concrete code/doc changes to make

### 2. Security review

Look for:

* Path traversal risks
* Writes outside the vault
* Unsafe server binding
* Missing auth checks
* Secrets in logs
* Over-broad vault access
* Arbitrary file read/write risks
* Unvalidated request payloads
* Direct write risks
* MCP/local server exposure risks
* Unsafe defaults
* Inadequate error messages
* Insecure dependency choices

Output:

* Security issues found
* Severity
* Recommended fix
* Files to change
* Tests to add

### 3. Production readiness review

Look for:

* Missing tests
* Missing docs
* Weak error handling
* Settings migration gaps
* Performance bottlenecks
* Broken build/typecheck assumptions
* Poor user-facing messages
* Incomplete acceptance criteria

Output:

* Release blockers
* Non-blocking improvements
* Required validation commands

After each `/loop`, implement required simplification and security fixes before proceeding.

Do not advance to the next milestone with known high-severity security issues.

After the required fixes from `/loop` are complete, run:

/compact

The `/compact` output must include:

* Current milestone
* Current architecture summary
* Important files created or modified
* Security decisions made
* Simplification changes made
* Known risks
* Deferred work
* Validation commands run
* Current build/test/typecheck status
* Next concrete actions

Then continue to the next milestone.

---

## 16. Initial implementation plan

Before writing code, inspect the repository.

If the repository is empty, initialize the project.

If files already exist, preserve existing work and propose careful changes.

Then produce:

A. Architecture plan
B. File tree
C. Implementation phases
D. Risk register
E. Acceptance criteria

After planning, implement in small steps.

Run `/loop` after the architecture plan before coding.

Resolve or document `/loop` findings.

Then run:

/compact

Run `/loop` after Milestone 1.

Resolve or document `/loop` findings.

Then run:

/compact

Run `/loop` after implementing server/MCP functionality.

Resolve or document `/loop` findings.

Then run:

/compact

Run `/loop` before declaring production readiness.

Resolve or document `/loop` findings.

Then run:

/compact

---

## 17. Acceptance criteria

The project is successful when:

* Plugin name is `claude-code-engram`
* Display name is `Claude Code Engram`
* Plugin builds successfully
* Plugin loads in Obsidian
* Settings are visible and persist
* Default memory root is `Claude Code/`
* Plugin rejects memory paths outside the active vault
* User can configure memory folder safely
* User can run “Claude Code Engram: Reindex Vault”
* User can search indexed notes
* Search returns note paths and relevant snippets
* User can add a memory entry
* Memory entry is written to `Claude Code/Memory/Inbox/pending-memory.md` by default
* User can create project memory structure under `Claude Code/Memory/Projects/`
* Local server is disabled by default
* Local server can be explicitly enabled
* Local server binds to localhost by default
* Local server requires token if configured
* At least `search_vault_memory` and `add_memory` work through the local server layer
* README explains how Claude Code should connect
* Security docs explain server risks and safe defaults
* Tests pass
* Typecheck passes
* Build passes
* `/loop` simplification/security review findings have been addressed or documented
* `/compact` summaries have been created between milestone loops

---

## 18. Development rules

Follow these rules:

* Do not skip architecture.
* Do not create a toy demo.
* Do not hard-code paths outside the Obsidian vault.
* Do not require cloud services for the default experience.
* Do not enable network server by default.
* Do not write directly into user notes unless explicitly enabled.
* Do not allow configured memory roots outside the vault.
* Prefer append-only memory writes.
* Keep interfaces clean and extensible.
* Keep user data local by default.
* Keep security warnings clear and practical.
* Document limitations honestly.
* Use `/loop` for simplification and security reviews.
* Use `/compact` after completed `/loop` review/fix cycles.
* Do not proceed past high-severity security findings without fixing them.
* Do not run `/compact` before high-severity security findings are fixed or explicitly blocked with justification.

---

## 19. Recommended first milestone

Implement Milestone 1:

* Plugin scaffold
* Settings tab
* `Claude Code/` memory root configuration
* Safe path validation
* Basic vault scanner
* Markdown chunker
* Local JSON index
* Lexical retrieval
* Search modal
* Add memory command
* Pending-memory.md writer
* README
* Basic tests

Then run:

/loop

The first `/loop` must verify:

* The design is not over-complicated
* The memory root cannot escape the vault
* Writes go only to `Claude Code/Memory/Inbox/pending-memory.md` by default
* The server is not accidentally enabled
* The plugin works without cloud credentials

Fix or document findings.

Then run:

/compact

Then implement Milestone 2:

* Control panel view
* Project memory folder creation
* Server mode
* Token auth
* `search_vault_memory`
* `add_memory`
* Claude Code integration documentation

Then run:

/loop

Fix or document findings.

Then run:

/compact

Then implement Milestone 3:

* Embedding provider abstraction
* Ollama embedding provider
* OpenAI-compatible embedding provider
* Vector retrieval
* Ranking improvements
* Better review UI

Then run:

/loop

Fix or document findings.

Then run:

/compact

---

## 20. Output expectations

Start by giving me:

1. Architecture plan
2. File tree
3. Implementation phases
4. Risk register
5. Acceptance criteria

Then run:

/loop

After the initial `/loop`, address required findings.

Then run:

/compact

After the initial `/compact`, implement Milestone 1 completely.

After implementation, run:

npm install
npm run typecheck
npm run test
npm run build

If any command fails, diagnose and fix it.

At the end of each milestone, provide:

* Summary of implemented features
* Files changed
* Test/build results
* `/loop` simplification findings
* `/loop` security findings
* Fixes made after `/loop`
* `/compact` summary
* Remaining risks
* Next recommended milestone

