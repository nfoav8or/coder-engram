# MCP / local server

> **Status: Implemented in Milestone 2.** The plugin can run a small, local,
> token-authenticated HTTP server that speaks JSON-RPC 2.0 (the MCP wire
> format) so Claude Code can query and propose memory. It is **disabled by
> default** and binds to `127.0.0.1` only.

## What it is

A minimal [Model Context Protocol](https://modelcontextprotocol.io) endpoint over
HTTP. It exposes a **curated, query-scoped** set of tools that drive the same
`EngramEngine` the Obsidian UI uses — so retrieval and write semantics are
identical whether a human or an agent triggers them. There is **no generic file
read/write tool** and **no way to dump the whole vault**.

## How it is built

The server is layered so that everything security-relevant is unit-tested
without opening a socket:

| File | Responsibility | Touches sockets? |
| --- | --- | --- |
| `src/server/auth.ts` | Bearer-token extraction + constant-time compare | no |
| `src/server/net.ts` | Loopback detection, Host/Origin (DNS-rebinding) guards | no |
| `src/server/mcp-tools.ts` | Tool registry, argument validation, rate limiting | no |
| `src/server/mcp-protocol.ts` | JSON-RPC 2.0 / MCP method dispatch | no |
| `src/server/local-server.ts` | The thin `node:http` shell + lifecycle | **yes** |

`local-server.ts` is the only file that imports `node:http`; it is a thin,
auditable shell around the pure layers above it.

## Enabling it

In **Settings → Local server**:

1. **Set a token.** Use the **Generate** button for a 256-bit random token.
   A token is strongly recommended for localhost and **mandatory** for any
   non-localhost bind.
2. **Enable local server.** It starts immediately on `127.0.0.1:<port>` (default
   port `3999`). The control panel shows `running · 127.0.0.1:3999`.
3. Register it with Claude Code (see [CLAUDE_CODE_INTEGRATION.md](CLAUDE_CODE_INTEGRATION.md)).

Changing the host, port, or token restarts the server automatically. The
**Restart Local Server** command forces a restart. Disabling the toggle stops it.

## Protocol

Standard MCP over HTTP (JSON-RPC 2.0). Supported methods:

| Method | Behavior |
| --- | --- |
| `initialize` | Returns `protocolVersion`, `capabilities.tools`, and `serverInfo`. Negotiates per the 2025-06-18 lifecycle rule: the requested version is agreed to when it is one this server implements (`2025-06-18`, `2025-03-26`, `2024-11-05` — wire-identical for `initialize`/`ping`/`tools/list`/`tools/call`, with one deliberate addition noted below), and anything else is answered with `2025-06-18` so the client can decide whether to continue. |
| `notifications/initialized` | Handshake completion (notification; no response). |
| `ping` | Liveness check. |
| `tools/list` | Lists the tools below with JSON-Schema input schemas. |
| `tools/call` | Invokes a tool. Tool failures are returned **in-band** as a result with `isError: true` — never as a transport error. The message names the failing note in vault-relative terms; absolute filesystem paths are stripped before it is sent (see [SECURITY.md](SECURITY.md)). |

Every request is a `POST` with `Content-Type: application/json` and an
`Authorization: Bearer <token>` header (when a token is configured).

## Tools

| Tool | Purpose | Notes |
| --- | --- | --- |
| `search_vault_memory` | Retrieval over the index (BM25 lexical by default; vector/hybrid when an embedding provider is configured). | Returns chunks with note path, heading, **line range**, **modified date** (staleness judgment when memories conflict), and snippet — **near-duplicates collapsed** (token overlap ≥ 0.8) so the same memory isn't returned (or token-charged) twice — only when the **Collapse near-duplicate hits** setting is on, which is off by default; no score float. Hits from the review inbox are tagged `[PENDING REVIEW — proposed, not yet accepted]` so an agent's own unreviewed proposal never reads as accepted memory. Filters: `folder`, `tag`, `project`, `sinceDays`. Limit capped at 25. Never returns whole notes. |
| `search_batch` | Several related queries in **one call**, merged into one de-duplicated page, each hit naming which queries it answered. | An agent exploring a topic asks three or four overlapping questions; asked one at a time that is three or four round trips returning heavily overlapping results, each paid for separately in context. Batching removes the overlap **once** — a chunk answering three questions is returned a single time. Fused by **Reciprocal Rank Fusion**, the same rank-based combination `HybridRetriever` uses to merge lexical with vector, and for the same reason: scores from different queries are not comparable, so rank is the only honest way to interleave them. A chunk several queries agree on therefore ranks above one only a single query found — a signal that is lost entirely when the questions are asked separately. **Not cheaper in provider work:** in vector or hybrid mode each query still embeds separately, and the queries run **sequentially** so five never become a concurrent burst. What it saves is round trips and duplicated context. Capped at 5 queries, and **charged once per query against the same budget as `search_vault_memory`** — a batch of five costs what five searches cost, never less. |
| `get_note_context` | Full **indexed** text of one note (or indexed attachment — with **Index attachments** on, extracted PDFs/Office documents/Canvas boards read like any note), passage by passage with heading + line range. | The follow-up to a search hit (which returns only a snippet). Inputs: `path` (required), `maxChars` (optional, default 12000, max 50000; truncates past this), `startLine`/`endLine` (optional, 1-based; return only passages overlapping that span — pass a search hit's line range to read deep into a long note without paging from the top), `outline` (optional; headings-only map of the note — line range + breadcrumb per passage, no body — a cheap map before a full read). A truncated read names the exact `startLine` to continue from and the note's full span. **In-scope only**: refused for notes not in the index — not a general file-read. **Rate-limited** (60/min). |
| `find_related_notes` | Link-graph neighbours of one **indexed** note: notes it links to + notes that link back. | Input: `path` (required). Links resolve by note name (Obsidian-style basename); only **indexed** notes appear (unresolved/excluded links are dropped), and an unindexed note is refused. Each direction lists up to **1500 characters** of links and reports how many more it has, so a hub/Map-of-Content note can't dump hundreds of paths. Budgeted in characters rather than link count because per-link cost varies ~3.8× with path depth, so one count cap would buy very different amounts of context per vault. **Rate-limited** (120/min). |
| `add_memory` | Propose a memory entry. | **Always appends to the review inbox** (`Memory/Inbox/pending-memory.md`). Direct writes are never exposed over the network, even when `allowDirectWrites` is on. **De-duplicated**: an entry whose content, type, and project match one already pending is not added again (reported as `already pending`), so a looping agent can't flood the inbox. Content is compared with whitespace collapsed and case folded — still an exact match on the words, not token overlap, so a restatement that adds detail is kept rather than silently dropped. Inputs are bounded per field AND per item: `content` 50 000 characters, `tags` 64 items of 128, `relatedPaths` 128 items of 512 — a count-only cap would leave a list field bounded by the 1 MB body instead. |
| `get_project_context` | Project memory (overview → architecture → decisions → tasks → open questions), each file labeled with its vault path. | Input: `maxChars` (optional, default 12000, max 50000). Clipping happens at file boundaries and **names the omitted files** (never a silent drop) with a pointer to `get_note_context`. **Rate-limited** (60/min). |
| `get_global_context` | Global memory (profile + preferences + conventions), path-labeled. | Input: `maxChars` (optional, same bounds and clipping behavior). **Rate-limited** (60/min). |
| `resolve_project` | Map a working directory, repo name, or guess to the project name this vault actually uses. | The agent knows a filesystem path; the plugin knows a folder name a person chose, and nothing connected them — so a near miss like `coder-engram` for `Coder Engram` returned **empty context, which reads as "this project has nothing yet" rather than "wrong name"**. The hint is treated as TEXT, never a path: only its last segment is read, nothing is resolved, and no filesystem outside the vault is touched. Matching folds case, Unicode form, and the `-`/`_`/space separators that distinguish a repo directory from a folder name. An **ambiguous hint is reported as ambiguous** — two projects differing only by punctuation fold to one key, and naming one would be a confident wrong answer while the other never surfaced. On a miss it names what does exist — up to 25, **saying how many it hid**, because silently truncating is the same failure again — since an agent cannot otherwise tell a spelling error from a project nobody has created. Reveals nothing `list_projects` does not already. **Rate-limited** (60/min). |
| `get_recent_changes` | Indexed notes changed in a recent window, newest first, as **paths and dates**. | The session warm-start read. Until now the only way to ask "what moved since I last looked" was a search, which meant inventing a query for something that is not a relevance question and hoping ranking surfaced recency. This answers it from the note→mtime map the index already holds: **no I/O, no embedding call, no scoring**. Returns **no note content** — the follow-up is `get_note_context` on whichever paths matter, so the agent decides what to spend context on. `sinceDays` accepts fractions (1 hour ≈ 0.04) because "what changed in the last hour" is the real question; the floor is ~1 hour so a caller cannot ask for a window that excludes everything and read the empty result as "nothing changed". An **empty index is reported distinctly** from "nothing changed": the answer is unknown rather than negative, and the fix is a reindex, not a wider window. Excluded notes cannot appear — the map holds only what was indexed. Capped at 200 notes and the shared `maxChars` budget. **Rate-limited** (60/min). |
| `list_pending_memory` | Memory proposals **awaiting human review** in the inbox, newest last. | Closes a loop that was open in one direction: `add_memory` reported only that a proposal landed, so an agent could not tell an accepted memory from a rejected one from a still-pending one, re-proposed facts it had already contributed, and the writer's dedup silently absorbed them. Optional `project` filter, applied by the **engine** and folded for case and Unicode form like every other project filter — the rule lives there because "does this entry belong to project X" is a domain question, and this codebase has been bitten before by that question being answered twice with different rules. Ordered **newest first** so that the entry limit and the character clip drop the same end; oldest-first meant the limit kept the newest and the clip then threw them away. Content is rendered with heading and `---` lines defused, so a proposal cannot forge an extra pending entry in the output and trick an agent into suppressing a genuine one. **Read-only** — it reports on the review queue and cannot act on it; applying or discarding an entry remains UI-only and absent from `ALL_TOOLS`. Takes no path argument, and reads only `pending-memory.md` through `MemoryWriter.readInbox`, so it is not a general file reader. Clipped by the shared `maxChars` budget (same schema and parser as the other bulk context reads) and 50 entries, keeping the newest and saying how many it is showing. **Rate-limited** (60/min). |
| `find_symbol` | Where a code symbol is **defined**. | Exact (case-folded) match against the symbols the chunker extracted from fenced code blocks — a lookup, not a search. Asking `search_vault_memory` for an identifier returns every passage mentioning it, ranked by how often, and the declaration is rarely the chattiest of them. Reads the same index as everything else, so an excluded note has no symbols to find and a retired section is dropped like everywhere else; it takes no path argument and returns locations plus a bounded snippet, never whole notes. A miss says so and points at `search_vault_memory`, because a symbol discussed only in prose genuinely has no declaration to find. **The review inbox is excluded outright** rather than labelled the way search labels it: `add_memory` content is written into an ordinary indexed note verbatim, fences included, so an agent could otherwise read its own unreviewed proposal back as an authoritative declaration — and a proposal is not a definition. The snippet is a **single line windowed onto the declaration**: slicing from the chunk start missed the declaration entirely on any chunk with prose above its code, and raw multi-line text would let a note forge an extra numbered entry, the same forgery the single-line rule closes for search snippets. **Rate-limited** (60/min). |
| **`tokenBudget`** | Cap a call's output in tokens rather than characters. | Accepted by the nine tools whose output can be large: `search_vault_memory`, `search_batch`, `get_note_context`, `get_project_context`, `get_global_context`, `get_recent_sessions`, `get_recent_changes`, `list_pending_memory` and `list_rejected_memory`. The others answer in a sentence (`add_memory`, `reindex_vault`) or under a fixed ceiling (`summarize_note` 4,000, `find_related_notes` 1,500, `list_projects` 4,000, `resolve_project` a capped name list), where a budget would be a knob with nothing behind it. An estimate (no tokenizer is bundled), conservative in the direction that matters: a budget buys fewer characters than it might, and a reported `estimatedTokens` is higher than the text probably costs, because overshooting takes the decision away from the caller. Given `maxChars` as well, the **tighter of the two wins** — they are two spellings of one request. Search trims at **result boundaries**, never mid-snippet. Floor of 256 tokens: below that a page has room for a preamble and little else, and a narrower query serves the caller better than a page too small to answer. Validated with the other arguments, so a bad value is refused whether or not the query happened to match anything. |
| **Structured results** | Seven tools return `structuredContent` beside the prose. | `search_vault_memory`, `search_batch`, `list_pending_memory`, `list_rejected_memory`, `get_recent_changes`, `resolve_project`, `list_projects`. Each declares an `outputSchema`, and only those seven do. The `content` array is unchanged and still carries the entire answer — the structured form exists so a caller citing a passage reads `path`/`startLine`/`endLine` as fields rather than parsing a human-written label, and it is never a substitute. The two halves are built from one decision rather than checked against each other afterwards: a listing works out how many entries fit in `maxChars` at **entry boundaries**, then renders the prose and the payload from that same slice, and bounds each entry's own text the same way. Rendering everything and slicing the joined prose afterwards left `maxChars` bounding only the channel a caller happened not to be reading — measured at 491 KB of content returned against a 1,000-character request. `total` still reports what was left out, and search results carry `pendingReview` so a consumer reading only fields still learns that a hit came from the unreviewed inbox. **On version:** `structuredContent` and `outputSchema` are 2025-06-18 additions, and this server emits them regardless of the version negotiated rather than keeping per-session state to suppress them: both are extra fields on a result object, which a JSON-RPC client ignores when it does not know them, and `content` stays complete for every client, so an older client sees exactly what it saw before. |
| `add_memory` overlap report | Names the existing memory a proposal most overlaps. | Computed by the engine at propose time, not passed in — it is an observation about the vault, so there is no schema field for it and a caller-supplied one is ignored. Scored by term containment against memory-root chunks only (pending proposals and the ledgers excluded: overlapping something nobody approved is not news, and `supersedes` cannot name it). Offline by construction — it runs in a write path, so no query embedding, and any failure means "no overlap" rather than a failed proposal. Reported, never acted on: it names the candidate and suggests `supersedes`, leaving the judgement to the agent and the reviewer. |
| `add_memory` + `supersedes` | Propose a memory that **replaces** an existing one. | Optional `"<path>#<heading>"`, in the shape a search result's label already prints. Validated against the memory root before the proposal is written: a target outside memory, or a path with no heading, is refused in-band — the first because retiring is a hide and a reference able to name any vault note would let a proposal suppress the user's own writing; the second because a bare path would retire a whole file in one click. The field is a **claim**: nothing in this tool surface can promote it, and the memory is retired only when a reviewer applies the entry in Obsidian. |
| `list_rejected_memory` | Memory proposals a reviewer **discarded**, with the reason they gave, newest first. | The other half of the loop `list_pending_memory` opened. A discard used to leave no trace, and "you rejected this" is indistinguishable from "nobody has looked yet" — so the agent's only rational move was to keep proposing. Reads `rejected-memory.md` only, through `MemoryWriter.readRejections`, with the same optional `project` filter (engine-owned, case- and Unicode-folded), the same newest-first ordering so `limit` and the `maxChars` clip drop the same end, and the same heading/`---` defusing so a record cannot forge an extra entry in the output. **Read-only** — clearing the ledger un-rejects those memories, which is a reviewer decision and stays UI-only, exactly as promotion does. **Rate-limited** (60/min). |
| `list_projects` | Project names under the projects root. | No inputs. Cheaper-looking than it is, in both directions: it lists every Markdown file in the vault and scans the paths, so its cost scales with vault size (~0.5 ms at 1 000 notes, ~3.5 ms at 20 000) and is spent on the app's main thread; and the names are not ours to assume short (200 chars where an agent supplies one), so the output is **clipped at 4 000 characters** with a count of how many are not shown — 1 000 projects at full name length would otherwise return 197 KB. **Rate-limited** (60/min). |
| `get_recent_sessions` | Most recent session notes for a project. | Inputs: `limit` (capped at 20), `maxChars` (optional; clips at session boundaries and names omitted sessions). **Rate-limited** (60/min). |
| `reindex_vault` | Rebuild the index from the vault. | **Rate-limited** (15 s cooldown). Refused when indexing is disabled. |
| `summarize_note` | Extractive summary of an indexed note. | Inputs: `path` (required), `maxSentences` (optional, default 5, max 20). Returns a selection of the note's **own sentences** — verbatim, in original order — never generated prose. **In-scope only**: refused for notes that are not in the index. Output is capped at **4000 characters** — sentence count alone does not bound cost, because units split on lines first and a line with no sentence terminator (pasted JSON, base64, a wide table row) stays one unit however long it is. **Rate-limited** (30/min). |

### On extractive summarization

`summarize_note` (added in Milestone 4) is delivered as **extractive**
summarization: it selects and returns the note's own sentences, verbatim and in
original order, never generated prose. There is still **no LLM backend** — a
configured embedding provider only improves *which* sentences are chosen
(embedding-centroid similarity with Maximal Marginal Relevance); with no provider
it uses offline lexical ranking, and it fails open to lexical if embedding
errors. It refuses notes that are not in the index, so it cannot surface
excluded content, and it never invents or truncates text into a fake "summary".

## Security controls

All enforced in code; see [SECURITY.md](SECURITY.md) for the full model.

- **Off by default.** No listener opens unless you explicitly enable it.
- **Localhost by default.** Binding a non-loopback host requires **both** the
  `allowNonLocalhost` opt-in **and** a token of at least 16 characters, or the
  server refuses to start (the Generate button makes a 64-character one).
- **Constant-time token auth.** Tokens are compared via SHA-256 digest +
  `timingSafeEqual`, so response timing does not leak the token. Auth is checked
  before the request body is read.
- **Failed-auth lockout.** After 10 failed authentications within 60 s every
  request is refused with `429` until the window drains — the constant-time
  compare defeats timing leaks, not volume, and an exposed bind could otherwise
  be guessed at wire speed. One global counter (not per client: an attacker can
  rotate addresses; the only legitimate client is your own agent).
- **Socket timeouts.** Headers must arrive within 15 s and the whole request
  within 30 s; idle keep-alive sockets close after 5 s. A slow-trickle client
  cannot hold sockets open for Node's default minutes. Tool execution time is
  not bounded by these — they cover receiving the request only.
- **DNS-rebinding protection.** The `Host` header must be loopback or the bound
  host; any `Origin` header must be a loopback origin. Only a genuinely absent
  `Origin` passes (non-browser clients send none); opaque browser origins
  (`Origin: null`) are rejected. Foreign values get `403`.
- **Request hardening.** `POST`-only (`405` otherwise), JSON content-type
  required (`415` otherwise), a **1 MB body cap** (`413`), and a **32-message
  cap on JSON-RPC batches** (`400`) so a single request can't monopolize the
  event loop.
- **`id` presence is distinguished from `id` validity.** Per JSON-RPC 2.0 a
  Notification is a request *without* an `id` member, and only those get no
  response. A message carrying an `id` that is not a string or finite number
  (`null`, a boolean, an object, `NaN`) is a malformed **request** and is
  answered with `InvalidRequest` rather than silently dropped — collapsing the
  two left such a client waiting forever for a reply the server had decided not
  to send.
- **Query-scoped only.** No arbitrary file access; the full vault is never
  returned wholesale.
- **Inbox-first writes.** `add_memory` never overwrites and never writes
  directly over the network.
- **Rate-limited operations.** `reindex_vault` has a 15 s cooldown; every other
  tool that reads or writes content has a per-minute sliding-window cap
  (`search_vault_memory` 120, `add_memory` 60, `summarize_note` 30,
  `get_note_context` 60, `find_related_notes` 120, and the bulk context reads
  `get_project_context` / `get_global_context` / `get_recent_sessions` 60 each),
  to bound sustained flooding.
- **Bounded output.** The bulk context reads accept `maxChars` (default 12000,
  max 50000) and truncate past it with a pointer to targeted recall, so
  session-priming can't silently balloon with a growing vault.
- **Serialized lifecycle.** Overlapping enable/disable/restart events are
  single-flighted, so the server can never bind two listeners or leak a port.
- **No secrets in logs.** The token is never logged; auth failures log only a
  reason (`missing-token` / `invalid-token`).

## Threat notes

- A token-less localhost server is reachable by **any local process/user** on
  the machine. Set a token unless you are on a single-user box and understand
  the exposure.
- Binding to `0.0.0.0` or a LAN IP exposes memory to your **network**. The plugin
  makes you opt in twice (flag + token) precisely because this is dangerous.
- Enable the server only while you need it.
