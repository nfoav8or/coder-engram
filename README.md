# Coder Engram

Safe, reviewable memory for Claude Code — stored as plain Markdown in your own vault.

**Coder Engram is the safe memory layer for Claude Code.** It turns your Obsidian vault into persistent, structured memory an AI coding agent can search and *propose to* — but every agent-written memory lands in a review inbox you approve or discard, so nothing is ever silently written to or edited in your notes. Everything is plain Markdown inside a `Claude Code/` folder in your vault; the retrieval index is a rebuildable local cache. No cloud API key is required for the default experience, and the optional local server is off by default, binds `127.0.0.1`, and is token-authenticated.

## What makes it different

Most Obsidian ↔ AI plugins are either a chat panel or a bridge that hands an agent broad read/write/edit access to your notes. Engram is neither:

- **Human-in-the-loop writes.** The agent *proposes*; you review. Direct edit, delete, and overwrite are never exposed to it — so an agent can't surgically rewrite (or quietly corrupt) your notes.
- **Durable agent memory, not a chatbot.** Structured global / project / session memory that accumulates across Claude Code runs and is captured for review — not an ephemeral chat.
- **Hardened by default.** Server off by default, localhost-only, constant-time token auth, DNS-rebinding guards, a curated tool surface, and no generic file access or full-vault dump.
- **Local-first, no lock-in.** Markdown is the source of truth; embeddings are opt-in (default is fully-offline lexical search); no cloud key for the default experience.

> **Status:** v0.9.8. The local server is **disabled by default** and binds to `127.0.0.1`. Vector retrieval is **disabled by default** too — the embedding provider defaults to `none`, so search stays fully offline and lexical until you point it at a local Ollama or an OpenAI-compatible endpoint. Attachment indexing is likewise opt-in, and local for every format except image text — that one delegates OCR to the Text Extractor plugin, which fetches its language data on first use (see [Network use](#network-use)). See [CHANGELOG.md](CHANGELOG.md) for release history and [docs/ROADMAP.md](docs/ROADMAP.md) for what is still deferred.

## What Coder Engram does

- Scans your vault's Markdown notes and builds a local, rebuildable JSON index.
- Chunks notes into retrieval-friendly, heading-aware segments.
- Retrieves the most relevant chunks for a query using local BM25 lexical search — no API keys, fully offline.
- Stores structured memory (global, project, and session notes) as Markdown under `Claude Code/`.
- Captures proposed memory into a reviewable inbox (`pending-memory.md`) by default, so nothing overwrites your notes without review.
- Exposes an optional, off-by-default local MCP/HTTP server so Claude Code can search memory, propose entries (inbox-first), and read project/global context — all over localhost with constant-time token auth.

## Features

### Memory you approve

- **Review inbox by default.** Every memory an agent proposes lands in `pending-memory.md` as a reviewable card showing its resolved destination, with per-entry **Apply**, **Edit & apply**, and **Discard**. Applying appends into the destination memory file and removes the entry from the inbox. Promotion is desktop-UI-only — never exposed over the network — always append-only, and validated inside the memory root.
- **Structured global / project / session memory** as plain Markdown under `Claude Code/`: project overview, architecture, decisions, tasks, and open questions, plus timestamped session notes and global profile / preferences / conventions.
- **De-duplicated proposals.** A repeat of a pending entry is not appended again, so a looping agent can't flood the inbox. Content is compared with whitespace collapsed and case folded — an exact match on the words, so a restatement that adds real detail is kept rather than silently dropped.

### Retrieval

- **Offline BM25 lexical search** with heading-match boost and folder / tag / project / recency filters. No API key, no network.
- **Optional vector and hybrid retrieval.** Cosine-similarity vector search and a hybrid retriever fusing lexical + vector rankings with Reciprocal Rank Fusion (the default when embeddings are configured). With no provider, or an unreachable one, retrieval silently stays lexical — vectors are never faked and never sit on the critical path.
- **Matches on filenames, aliases, and headings**, not just body text, so a note named `Quartzine Protocol.md` is findable by its name and an alias-only hub note is reachable at all.
- **Result pages built for an agent's context budget**: precise line ranges, modified dates for staleness judgement, and densest-window snippets. Three **Context savings** toggles — collapse near-duplicate hits, cap one note's share of a page, merge overlapping passages — are each opt-in and off by default, because each chooses what the agent doesn't need and can hide something you wanted to see.
- **Measured, not asserted.** `npm run eval` scores golden queries (recall@8 / MRR per query class) and the context cost of an answer; `npm run bench` measures index build and query latency at production scale.

### Reading notes without burning context

- **`get_note_context`** returns one note's indexed text passage by passage with headings and line ranges — the follow-up to a search hit. Supports **ranged reads** (`startLine` / `endLine`) to jump straight into a long note, and an **outline mode** that returns a headings-only map (line range + breadcrumb, no body) as a cheap survey before a full read. Truncated reads name the exact line to continue from.
- **`find_related_notes`** walks the wikilink graph from an indexed note — what it links to and what links back.
- **Honest extractive `summarize_note`.** Returns a selection of the note's **own sentences**, verbatim and in original order — never generated prose, because there is no LLM backend. Ranked by lexical frequency-centrality offline, or by embedding-centroid similarity with MMR when a provider is reachable.
- **Every read is bounded in characters**, the unit an agent actually pays in, so no tool can return far more than its limit suggests.

### Attachments (opt-in)

With **Index attachments** on, text-bearing attachments are extracted and indexed exactly like notes — same chunking, same incremental refresh, same exclusions, same tools:

- **PDFs**, via Obsidian's own bundled PDF engine (one `Page N` section per page).
- **Microsoft Office** — `docx`, `pptx`, `xlsx` — and **LibreOffice** — `odt`, `odp`, `ods`.
- **RTF**, plain text (`txt`, `csv`), and **Canvas** boards (text cards, group labels, edge labels).

Extraction for all of the above is dependency-free and fully local: the bytes never leave your machine, extracted text is cached in a rebuildable index file, and turning the setting off deletes that cache. (Images are the one exception, and are a separate opt-in — see below.)

**Text inside images** is a separate opt-in (**Index text inside images**). Rather than bundling an OCR engine — megabytes of WebAssembly, plus language data fetched at runtime, which Obsidian's developer policy disallows — it delegates to the [Text Extractor](https://github.com/scambier/obsidian-text-extractor) plugin if you have it. With that plugin absent, nothing happens. Note that Text Extractor downloads its OCR language data on first use, so this is the one attachment path that can touch the network. Scanned PDFs still yield no text.

### Local server (off by default)

- **MCP over JSON-RPC 2.0** so Claude Code can search memory, read context, and propose entries.
- **Hardened**: disabled by default, binds `127.0.0.1`, constant-time bearer-token auth, DNS-rebinding (Host/Origin) guards, POST-only with a 1 MB body cap, and per-tool rate limits.
- **Curated tool surface** — no generic file read/write, no full-vault dump, and network writes are *always* inbox-first even when direct writes are enabled in the desktop settings.

## Setting up the local server

The server is a thin `node:http` shell (`src/server/local-server.ts`) around pure, unit-tested MCP layers. It is **off by default**. To use it:

1. Set a strong **Server token** in settings.
2. Enable **Enable local server**.
3. Point Claude Code at `http://127.0.0.1:3999` (default port) with the token as a bearer credential.

Writes proposed over the network **always** go to the review inbox — the server never performs direct writes, even if **Allow direct memory writes** is enabled in the desktop settings. See [docs/MCP_SERVER.md](docs/MCP_SERVER.md) and [docs/CLAUDE_CODE_INTEGRATION.md](docs/CLAUDE_CODE_INTEGRATION.md).

## Embeddings & vector retrieval

Vector search is opt-in. The **Embedding provider** setting defaults to `none`, and until you change it retrieval is lexical BM25 only — no network calls, no API key. Two providers are available:

- **Ollama** (local): embeds against a local Ollama server (default endpoint `http://127.0.0.1:11434`). No API key, and note text never leaves your machine. Set the **Embedding model** to a model your Ollama has pulled.
- **OpenAI-compatible**: embeds against any OpenAI-compatible `/embeddings` endpoint (OpenAI, LM Studio, LocalAI, vLLM, …). **This sends your indexed note text to the configured endpoint**, which may be remote — an explicit, opt-in data-egress choice. It requires an endpoint, a model, and an API key (a secret, stored locally and never logged). The settings UI shows a notice when you select it.

Embedding happens at index time (reindex/refresh) and is cached in `Index/embeddings.json` inside the vault; unchanged chunks are reused so re-embedding is incremental. **Retrieval mode** (`lexical`, `hybrid`, or `vector`; default `hybrid`) controls how vectors are used. If the provider is unavailable — unset, unreachable, or erroring — search transparently degrades to lexical rather than failing. Excluded/sensitive notes are never indexed, so they are never embedded or sent anywhere. See [docs/SECURITY.md](docs/SECURITY.md) for the data-egress details.

## Installation (from a release)

1. Download `main.js`, `manifest.json`, and `styles.css` from a release.
2. Optionally verify them. Every release also publishes `SHA256SUMS`, and from v0.9.0 the assets carry signed build provenance, so you can confirm they were built by the release workflow from the tag they claim:

   ```bash
   sha256sum -c SHA256SUMS --ignore-missing        # or: shasum -a 256 -c
   gh attestation verify main.js --repo nfoav8or/coder-engram
   ```

3. Create the folder `<vault>/.obsidian/plugins/coder-engram/`.
4. Copy the three files into that folder.
5. In Obsidian: **Settings → Community plugins → Reload plugins**, then enable **Coder Engram**.

This is a desktop-only plugin (`isDesktopOnly: true`, minimum Obsidian 1.7.2).

### Install script (Linux/macOS)

`scripts/install.sh` automates the steps above: it downloads the release assets, verifies them against the release's `SHA256SUMS` (published from v0.6.0 on), copies them into a vault you pick (auto-detected from Obsidian's vault registry), and — only with `--enable` — turns the plugin on. In keeping with this project's safety posture, please download and read it rather than piping it straight to bash:

```bash
curl -fsSL https://raw.githubusercontent.com/nfoav8or/coder-engram/main/scripts/install.sh -o install.sh
less install.sh   # read what you're about to run
bash install.sh --vault "/path/to/YourVault"
```

Run `bash install.sh --help` for options (`--version x.y.z`, `--enable`). Requires `curl` plus `python3` or `jq` for vault auto-detection. Checksum verification uses whichever of `sha256sum`, `shasum`, or `openssl` the machine has — stock macOS ships no `sha256sum` — and refuses to install on a mismatch, or on an asset the manifest does not cover.

## Manual installation (from source)

1. Build the plugin (see [Building](#building)).
2. Copy the build outputs — `main.js`, `manifest.json`, and `styles.css` — into:

   ```
   <vault>/.obsidian/plugins/coder-engram/
   ```

3. Reload plugins in Obsidian and enable **Coder Engram**.

## Development setup

```bash
npm install
npm run dev      # esbuild watch build
```

`npm run dev` rebuilds `main.js` on change. Point it at a test vault by copying (or symlinking) the outputs into that vault's `.obsidian/plugins/coder-engram/` folder. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for details.

## Building

```bash
npm run build    # typecheck + production esbuild bundle
```

Other scripts:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Watch build (development) |
| `npm run build` | Typecheck then production bundle |
| `npm run test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` | ESLint over `.ts` sources |
| `npm run typecheck` | `tsc --noEmit` |

## Releasing

Releases are published by the `release.yml` GitHub Actions workflow whenever a
version tag is pushed. It runs the full gate (typecheck, lint, test, build),
attests the built artifacts, and attaches `main.js`, `manifest.json`,
`styles.css`, and a `SHA256SUMS` manifest to a GitHub release. To cut one:

```bash
npm version 0.9.0        # bumps package.json + syncs manifest.json / versions.json
git push --follow-tags   # pushes the commit and the tag
```

Two checks run before anything is published: the tag must equal the
`manifest.json` version (a leading `v` is tolerated), and `versions.json` must
carry an entry for it that agrees with the manifest's `minAppVersion` — which is
what `npm version` writes, so a mismatch means the manifest was edited by hand.

## Configuration

Settings live under **Settings → Coder Engram**. Key settings and their safe defaults:

| Setting | Default | Notes |
| --- | --- | --- |
| Enable indexing | `true` | Scan and index vault notes. |
| Memory root | `Claude Code` | Vault-relative folder for all plugin-managed memory. Must stay inside the vault. |
| Included folders | *(empty)* | Allowlist; empty means the whole vault. |
| Excluded folders | *(empty)* | Folders to skip. Matched on whole path segments, ignoring case and Unicode form (so an accented name typed here matches the same name stored decomposed by macOS). |
| Excluded tags | *(empty)* | Notes with any of these tags are never indexed. |
| Excluded path patterns | *(empty)* | Glob (`*`, `**`) or substring patterns for sensitive notes. |
| Index attachments | `false` | Extract and index text from PDFs (Obsidian's bundled PDF engine), Office documents (docx/pptx/xlsx, odt/odp/ods, rtf — dependency-free extraction), plain text (txt/csv), and Canvas cards, locally. Exclusions apply; extracted text is searchable/readable over the local server like any note. |
| Index text inside images | `false` | Reads text out of PNG/JPG/WEBP/BMP attachments by delegating to the [Text Extractor](https://github.com/scambier/obsidian-text-extractor) plugin; with that plugin absent, nothing happens. **The one attachment path that can cause network activity** — Text Extractor downloads its OCR language data on first use. Requires **Index attachments**. |
| Auto-index on file change | `false` | Debounced (~2.5s) refresh when notes change. |
| Default project | *(empty)* | Used by project-context and add-to-project commands. |
| Embedding provider | `none` | Lexical BM25 always works with `none`. `ollama` and `openai-compatible` enable vector/hybrid retrieval; `mock` is a deterministic dev provider. |
| Embedding model | *(empty)* | Model name for the selected provider (required for `ollama` and `openai-compatible`). |
| Retrieval mode | `hybrid` | `lexical`, `hybrid`, or `vector`. Forced to lexical whenever the provider is `none` or unavailable. |
| Embedding endpoint | *(empty)* | Base URL for the provider. Ollama defaults to `http://127.0.0.1:11434`; OpenAI-compatible needs the full base URL including any version prefix. |
| Embedding API key | *(empty)* | Secret bearer key for OpenAI-compatible endpoints. Stored locally, sent only in the `Authorization` header, and never logged. |
| Embedding batch size | `16` | Chunks embedded per request at index time; clamped to 1–512. |
| Enable local server | `false` | Disabled by default. Localhost MCP/HTTP bridge for Claude Code. |
| Server host | `127.0.0.1` | Localhost only unless "Allow non-localhost binding" is on. |
| Server port | `3999` | |
| Server token | *(empty)* | Bearer token for server requests; compared in constant time. Required to bind a non-localhost host. |
| Allow non-localhost binding | `false` | Off by default. Binding a non-localhost host also requires a token. Exposes memory to your network — not recommended. |
| Allow direct memory writes | `false` | When off, all writes go to the review inbox. |
| Append-only writes | `true` | Writes only append, never overwrite. |
| Collapse near-duplicate hits | `false` | Drops a search hit whose text nearly repeats a higher-ranked one. |
| Cap one note's share of a page | `false` | Stops one long note filling a whole result page. |
| Merge overlapping passages | `false` | Joins a section's consecutive windows on a full-note read, sending the carried overlap once. |
| Debug logging | `false` | Logs to the developer console; secrets are always redacted. |

The memory root is validated on entry: a value that would escape the vault is rejected.

## Obsidian usage

The plugin registers twelve commands (command-palette names shown):

1. **Coder Engram: Open Control Panel**
2. **Coder Engram: Reindex Vault**
3. **Coder Engram: Search Memory**
4. **Coder Engram: Summarize Current Note**
5. **Coder Engram: Add Memory**
6. **Coder Engram: Add Current Note to Project Memory**
7. **Coder Engram: Create Project Memory Folder**
8. **Coder Engram: Show Project Context**
9. **Coder Engram: Review Pending Memory**
10. **Coder Engram: Start Session Note**
11. **Coder Engram: End Session Note**
12. **Coder Engram: Restart Local Server**

The **Control Panel** (right sidebar, also on the ribbon "brain-circuit" icon) shows the memory root, indexed-note and chunk counts, last-indexed time, and server status, plus quick buttons: Reindex, Search, Add memory, Review inbox, New project, Project context.

## Claude Code usage

Programmatic access from Claude Code runs over the local MCP/HTTP server, which is **disabled by default**. Once you set a token and enable it, Claude Code can search memory, propose entries (inbox-first), and read project/global context. You can still use the plugin entirely through Obsidian commands and by reading/writing the Markdown memory folder yourself.

See [docs/MCP_SERVER.md](docs/MCP_SERVER.md) for the server design and [docs/CLAUDE_CODE_INTEGRATION.md](docs/CLAUDE_CODE_INTEGRATION.md) for the workflow and an MCP config example.

## Memory folder structure

All plugin-managed memory lives under the configured root (default `Claude Code/`):

```
Claude Code/
  Memory/
    Global/
      profile.md
      preferences.md
      conventions.md
    Projects/
      <project-name>/
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
    chunks.json
    metadata.json
    embeddings.json
  Config/
    plugin-settings-backup.json
```

Markdown files are the durable source of truth; the JSON files under `Index/` are a rebuildable cache. See [docs/MEMORY_MODEL.md](docs/MEMORY_MODEL.md).

## Security model

- Everything the plugin reads or writes stays inside the vault. `resolveInVault` is the single path choke-point and rejects absolute paths and `..` traversal.
- Proposed memory goes to the append-only review inbox by default. Direct writes to memory files are double-gated (require an explicit setting and stay inside the memory root).
- The local server is disabled by default, binds to `127.0.0.1`, uses constant-time bearer-token auth, and applies DNS-rebinding (Host/Origin) guards. It refuses to bind a non-localhost host unless you both allow it and set a token. Server writes are always inbox-first, and no generic file access or full-vault dump is exposed.
- Debug logging is off by default and redacts secrets when on.

Full details: [docs/SECURITY.md](docs/SECURITY.md).

## Network use

By default the plugin makes **no network connections at all**: search is offline lexical BM25, and the local server is off. Network activity exists only when you explicitly enable it:

- **Embeddings (opt-in).** If you set the embedding provider to **Ollama**, the plugin sends indexed note text to your configured Ollama endpoint (local by default, `http://127.0.0.1:11434`) to compute embeddings. If you set it to **OpenAI-compatible**, indexed note text is sent to the endpoint you configure (which may be a remote service such as OpenAI) for the same purpose; the API key is sent only in the `Authorization` header and never logged. Notes excluded from indexing are never embedded, so their content is never sent anywhere.
- **Local MCP/HTTP server (opt-in).** When enabled, the plugin listens on `127.0.0.1` so local tools such as Claude Code can query memory and propose entries to the review inbox. It makes no outbound connections; binding a non-localhost address requires an explicit second opt-in plus a token.

- **Text inside images (opt-in).** This path delegates OCR to the [Text Extractor](https://github.com/scambier/obsidian-text-extractor) plugin, which downloads its language data from the internet on first use. That download is the companion plugin's behaviour, not this one's — your image bytes are not sent anywhere — but enabling **Index text inside images** is what triggers it, so it is listed here rather than buried in the feature description.

Every other attachment path — PDF, Office, RTF, plain text, Canvas — runs entirely locally, and the bytes never leave your machine. There is no telemetry of any kind, and nothing is read or written outside the vault.

## Limitations

- **`summarize_note` is extractive, not abstractive.** It selects the note's own sentences; there is no LLM/generative backend, so it never rewrites or paraphrases. It also only works on notes that are in the index.
- **Desktop only.** `isDesktopOnly: true`.
- Attachment indexing covers born-digital **PDF text, Microsoft Office (docx/pptx/xlsx/rtf), LibreOffice (odt/odp/ods), plain text (txt/csv), and Canvas text cards** (opt-in). **Text inside images** is a separate opt-in that needs the Text Extractor plugin installed; without it, images stay unindexed. Scanned/image-only PDFs still yield no text either way — Text Extractor's own PDF OCR path is not used, as its README flags it as unreliable. Spreadsheet numeric cells are skipped (text cells and sheet names are indexed).

## Roadmap

- **M1 (done):** local memory + lexical RAG.
- **M2 (done):** control-panel polish, project creation, local MCP/HTTP server with constant-time token auth and DNS-rebinding guards, curated inbox-first tools, Claude Code integration docs.
- **M3 (done):** embedding providers (Ollama, OpenAI-compatible) behind an injected HTTP boundary, vector + hybrid retrieval, and a vault-local vector cache.
- **M4 (done):** richer pending-memory review UI with per-entry apply/edit/discard, and an honest extractive `summarize_note` (Summarize Current Note command + MCP tool).
- **M5 (done):** GitHub Actions CI (typecheck/lint/test/build) and a tag-driven release workflow that publishes the plugin artifacts, plus `version-bump.mjs` tooling that keeps `manifest.json`/`versions.json` in sync.
- **M6 (done):** retrieval quality — precise line spans with open-at-line, densest-window snippets, per-note result diversity, memoized corpus stats (~7× faster lexical queries), a scale benchmark, and a real-Obsidian e2e harness.
- **M7 (done):** deeper Claude Code loop — `get_note_context`, `find_related_notes`, `add_memory` de-duplication, embeddings no-op-persist guard.
- **M8 (done):** sharper/cheaper loop — ranged reads, dated + de-duplicated + backfilled search pages with `[PENDING REVIEW]` labels, bounded and rate-limited context tools, O(changed) refresh I/O, and the embedding-settings reload fix.
- **M9 (done):** rename to Coder Engram, community-catalog compliance (sentence-case UI, `setHeading()`/`setTitle()`, CSS-class styling, network-use disclosure), and a settings/UI correctness bundle (blur-commit settings, server config snapshot + no-op rebind skip, reindex guard, search-race fix).
- **M10 (done):** attachments become memory — PDF (via Obsidian's bundled engine), Office/LibreOffice, RTF, plain text and Canvas extraction behind one injected boundary, with an mtime-keyed cache and field matching in ranking.
- **M11 (done):** bounded by the unit you pay in — a per-file text ceiling, a corpus-wide budget that keeps a large vault's index serializable, and a section budget set by measured relevance.
- **M12 (done):** the agent's context is your choice — the three output reductions became individual opt-in toggles, all off by default.
- **M13 (done, v0.9.0):** untrusted files, safely — image text via plugin interop, bounds in time as well as size (PDF, OCR, and outbound HTTP each race a timer), four security fixes to existing paths, signed build provenance on release assets, and type-aware linting.
- **Future:** non-desktop support, scanned-PDF OCR, and alternative local vector stores.

Details: [docs/ROADMAP.md](docs/ROADMAP.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the gate to run, the two layering rules the build enforces, and how to check that a new test actually holds something.

## License

MIT. See [LICENSE](LICENSE).
