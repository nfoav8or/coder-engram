# Security model

Coder Engram is local-first and privacy-preserving by default. It requires no cloud service or API key, keeps every read and write inside the active vault, and defaults to reviewable, append-only memory writes.

## Principles

1. **Everything stays inside the vault.** All plugin-managed memory lives under the configured memory root (default `Claude Code/`) inside the active Obsidian vault. The plugin never writes to arbitrary filesystem locations.
2. **One path choke-point.** `resolveInVault` (in `src/utils/paths.ts`) is the single function every memory read/write routes through. It normalizes vault-relative paths, resolves `.`/`..`, and throws `PathSecurityError` on anything absolute, drive/UNC-rooted, containing control characters, or escaping its root via `..`. `isInsideRoot` uses segment-boundary comparison, so `Claude Codex` is not treated as inside `Claude Code`.
3. **Defense in depth at the boundary.** Every `VaultAdapter` method also calls `assertRelative` and refuses absolute paths, even though callers are expected to sanitize first.
4. **Writes are reviewable by default.** Proposed memory is appended to the review inbox (`Memory/Inbox/pending-memory.md`), not written into your notes. You apply or discard entries by hand.
5. **Direct writes are double-gated.** `MemoryWriter.directWrite` throws unless `allowDirectWrites` is enabled *and* the target resolves inside the memory root; with `appendOnly` on it only ever appends.
6. **The server is off by default.** The local MCP/HTTP server (M2) is disabled by default and binds to `127.0.0.1`. It refuses to bind a non-localhost host unless you both enable `server.allowNonLocalhost` **and** set a token. Authentication is constant-time (SHA-256 digest + `timingSafeEqual`), DNS-rebinding is blocked by Host/Origin guards, requests must be POST with `Content-Type: application/json` under a 1 MB cap, and writes over the network are inbox-first only. See "Local server security controls" below.
7. **Secrets never reach the console.** Debug logging is off by default. When on, the logger recursively redacts any context value whose key looks like a secret (`token`, `secret`, `apikey`, `api_key`, `authorization`, `password`, `bearer`).

## Safe defaults

| Setting | Default | Why it is safe |
| --- | --- | --- |
| `memoryRoot` | `Claude Code` | Inside the vault; validated on entry. |
| `server.enabled` | `false` | No network listener unless you opt in. |
| `server.host` | `127.0.0.1` | Localhost only; not reachable from the network. |
| `server.allowNonLocalhost` | `false` | A non-localhost bind is refused unless this is on *and* a token is set. |
| `server.token` | *(empty)* | Set a strong token before enabling the server; compared in constant time. |
| `allowDirectWrites` | `false` | All writes go to the review inbox. |
| `appendOnly` | `true` | Memory is never overwritten in place. |
| `debugLogging` | `false` | No console noise; secrets redacted when enabled. |
| `embeddingProvider` | `none` | Works fully offline with lexical search; no external calls. |

## Sensitive-note controls

You can keep notes out of the index entirely with **Excluded folders**, **Excluded tags**, and **Excluded path patterns** (glob or substring). These filters run in the vault scanner before content is read where possible. Retrieval also only ever returns chunks that were indexed, so excluded notes cannot surface in search results.

## Attachment indexing (opt-in)

**Index attachments** is off by default. When enabled, text is extracted from PDFs (Obsidian's bundled PDF engine), Office documents (docx/pptx/xlsx, odt/odp/ods, rtf), plain text (txt/csv), and Canvas boards — **entirely locally**; attachment bytes never leave the machine. Extracted text is stored in `Index/extracted.json` inside the vault (a rebuildable cache, keyed by file mtime) and is **deleted when the setting is turned off**, so possibly-sensitive extracted text is not retained. All exclusion filters (folders, tags, patterns) apply to attachments exactly as to notes.

Attachments are treated as **untrusted bytes**: the dependency-free ZIP/XML/RTF parsers are hardened against crafted input — a 64 MB per-entry decompression cap (declared sizes are verified against the actual inflated stream) plus a 256 MB aggregate cap and 500-part ceiling per archive (so a payload spread across many entries is bounded too), strictly linear-time scanning (no backtracking parsers that can freeze the renderer on malformed structure), a bounded group-nesting depth, and a 50 MB per-attachment read cap. The metadata pass over extracted text (tags/links) is likewise linear-time — its link scans are index walkers, not backtracking regexes. A corrupt, encrypted, or hostile file extracts as "no text" and is skipped, never an error or a hang.

## Risks of enabling direct writes

Turning on **Allow direct memory writes** lets desktop tools modify memory files without going through the review inbox. Even then, writes are constrained to inside the memory root, and with **Append-only writes** on (the default) existing content is never overwritten. If you additionally turn *off* append-only, non-destructive behavior is lost and a bad write could replace an existing memory file's contents. Recommendation: leave direct writes off, or keep append-only on if you enable them. Note that `allowDirectWrites` does **not** apply over the network — the server's `add_memory` tool is always inbox-first (see below).

## Local server security controls

The local MCP/HTTP server (`src/server/`) lets external tools such as Claude Code query and propose memory over HTTP. It is a thin `node:http` shell (`local-server.ts`) around pure, unit-tested layers (`auth.ts`, `net.ts`, `mcp-protocol.ts`, `mcp-tools.ts`). The implemented controls:

- **Off by default.** No listener runs until you enable the server.
- **Localhost bind.** Binds to `127.0.0.1` by default. Binding a non-localhost host is refused unless `server.allowNonLocalhost` is enabled **and** a token is set; the settings UI warns before you expose memory to the network.
- **Constant-time token auth.** A configured bearer token is required on every request and compared via a SHA-256 digest with `timingSafeEqual`, so timing does not leak the token. Tokens are never logged.
- **DNS-rebinding protection.** The `Host` header is validated against the bound address, and any `Origin` that is present must be loopback — a malicious web page's cross-origin request is rejected. Only a genuinely absent `Origin` is allowed through; opaque browser origins (`Origin: null`) are rejected.
- **Request hardening.** POST-only (other methods get 405), `Content-Type: application/json` required (else 415), a 1 MB request-body cap (413 on overflow), and a 32-message cap on JSON-RPC batches (400) so one request can't monopolize the event loop. Malformed JSON and invalid JSON-RPC yield structured errors.
- **Curated, query-scoped tools.** Only `search_vault_memory`, `add_memory`, `get_project_context`, `get_global_context`, `list_projects`, `get_recent_sessions`, `reindex_vault`, `summarize_note`, `get_note_context`, and `find_related_notes` are exposed — the last three operate on **in-index notes only** (an excluded or unindexed note is refused). There is no generic file read/write tool and no way to enumerate or dump the whole vault, and no tool can promote inbox entries into memory files.
- **Inbox-first writes over the network.** `add_memory` always appends to the review inbox and never performs a direct write, even when the desktop `allowDirectWrites` setting is on. Search results coming *from* the inbox are labelled `[PENDING REVIEW — proposed, not yet accepted]`, so an agent's own unreviewed proposal never reads back as accepted memory.
- **Rate limiting and bounded output.** `reindex_vault` has a 15 s cooldown; every other content-returning tool has a per-minute sliding-window cap (`search_vault_memory` and `find_related_notes` 120; `add_memory`, `get_note_context`, and the bulk context reads 60; `summarize_note` 30) to bound sustained flooding (disk fill / CPU abuse). The bulk context reads (`get_project_context` / `get_global_context` / `get_recent_sessions`) additionally cap their output at `maxChars` (default 12000, max 50000), and `find_related_notes` lists at most 50 notes per direction (naming the remainder) so a hub note's link list is bounded too.
- **Serialized lifecycle.** Overlapping enable/disable/restart events are single-flighted, so the server can never bind two listeners or leak a port.
- **Secrets redacted.** Startup and request logs never include the token; the debug logger redacts secret-shaped keys.

Recommendations: set a strong token, enable the server only while you need it, and keep it bound to `127.0.0.1`. See [MCP_SERVER.md](MCP_SERVER.md) for the design and [CLAUDE_CODE_INTEGRATION.md](CLAUDE_CODE_INTEGRATION.md) for the workflow.

## Embedding providers (M3)

Vector and hybrid retrieval are optional and off by default: `embeddingProvider` is `none`, so search is lexical BM25 with no outbound requests. When you opt in, all client HTTP goes through a single boundary — `ObsidianHttpClient`, which wraps Obsidian's `requestUrl` (`src/core/obsidian-http-client.ts`). The embedding providers themselves never import `obsidian`; they depend only on the `HttpClient` interface, so nothing but this one adapter touches the network.

- **Local vs. remote.** The Ollama provider embeds against a local server (default `http://127.0.0.1:11434`) with no API key — note text stays on your machine. The **OpenAI-compatible provider transmits your indexed note text to the configured `/embeddings` endpoint**, which may be remote. That is a genuine data-egress consideration, so it is opt-in: the provider defaults to `none`, and the settings UI shows a notice when you select OpenAI-compatible.
- **Excluded notes are never sent.** Only chunks that were indexed are embedded, and the vault scanner's excluded folders / tags / path patterns keep sensitive notes out of the index in the first place — so they are never embedded and never leave the vault.
- **API key is a secret.** The OpenAI-compatible key is sent only in the `Authorization: Bearer` header, never in a URL or a log line. The debug logger's secret-key redaction already covers `apikey`/`api_key`, and provider error messages deliberately omit the response body.
- **Vectors cached in the vault.** Computed embeddings are written only to `Index/embeddings.json` through the same `VaultAdapter` choke-point as the rest of the index, so the cache cannot escape the vault. It is a rebuildable cache, not a source of truth.
- **Fails open to offline search.** If a configured provider is unset, unreachable, or errors, retrieval degrades to lexical rather than failing — a down backend never blocks search and never leaks. Vectors are never fabricated.
- **Bounded requests.** `requestUrl` has no abort, so `ObsidianHttpClient` races each call against a timeout timer (5s liveness, 60s embed). A stalled or black-holed endpoint can never hang a search or block indexing — it degrades to lexical when the timer fires.
- **No cross-model scoring.** The vector cache records the backend identity it was built with (provider + model + hashed endpoint + hashed key). A query is only scored against cached vectors when that identity matches the active provider; after a model/endpoint swap or a stale-on-disk restart, search degrades to lexical until a re-embed catches up, rather than returning plausible-but-wrong rankings from mismatched vectors.

Honest limitation: the API key is stored in plaintext locally, in Obsidian's own `data.json` and in the `Config/plugin-settings-backup.json` settings backup — exactly like the server token. Anyone with read access to those files can read the key. Do not sync `data.json` or the settings backup out of the vault, and treat the key as you would any other stored credential.

## Review UI & summarization (M4)

Milestone 4 adds a richer review UI for the pending-memory inbox and an extractive `summarize_note`. Neither introduces new network egress or a generative backend.

### Applying (promoting) a reviewed entry

The **Review Pending Memory** modal can now **Apply** a pending entry: it is appended into the destination memory file resolved from its type/project (`resolveApplyDestination`) and then removed from the inbox. Apply is the human-in-the-loop counterpart to inbox-first writes, so it is authorized differently from unattended direct writes:

- **UI-only.** Apply/promotion is reachable only from the desktop review modal. The local MCP/HTTP server never exposes an apply or promotion tool — over the network `add_memory` remains inbox-first, and there is no way to promote an entry into a memory file.
- **Not gated by `allowDirectWrites`.** That setting governs *unattended/tool* direct writes. Promotion is a deliberate, per-entry human action reached only from the review UI, so it is intentionally not blocked by it. It is still constrained by defense-in-depth: the destination is validated inside the memory root (`isInsideRoot`).
- **Always append.** Promotion only ever appends to the destination file; it never overwrites an existing memory file, regardless of the `appendOnly` setting.

### `summarize_note` (extractive)

`summarize_note` returns a selection of the note's own sentences — verbatim, in original order. It is extractive, never generative: there is no LLM backend. A configured embedding provider, when reachable, only improves which sentences are selected (embedding-centroid similarity with Maximal Marginal Relevance) and is never required (lexical frequency-centrality works offline). Its safety properties:

- **In-scope only.** It summarizes only notes that are in the index. An excluded or unindexed note has no chunks and the request is refused, so a summary can never become a side channel that surfaces a note the exclusion filters were meant to keep out.
- **Fails open.** An embedding-provider error degrades to lexical selection rather than hard-failing, matching the rest of the retrieval path.
- **Bounded work.** The note's sentence-units are capped (200) so a single huge note cannot fan out into an unbounded embedding request.
