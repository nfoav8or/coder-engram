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
| `initialize` | Returns `protocolVersion`, `capabilities.tools`, and `serverInfo`. Echoes the client's requested protocol version. |
| `notifications/initialized` | Handshake completion (notification; no response). |
| `ping` | Liveness check. |
| `tools/list` | Lists the tools below with JSON-Schema input schemas. |
| `tools/call` | Invokes a tool. Tool failures are returned **in-band** as a result with `isError: true` — never as a transport error. |

Every request is a `POST` with `Content-Type: application/json` and an
`Authorization: Bearer <token>` header (when a token is configured).

## Tools

| Tool | Purpose | Notes |
| --- | --- | --- |
| `search_vault_memory` | Lexical (BM25) retrieval over the index. | Returns chunks with note path, heading, snippet. Filters: `folder`, `tag`, `project`, `sinceDays`. Limit capped at 25. Never returns whole notes. |
| `add_memory` | Propose a memory entry. | **Always appends to the review inbox** (`Memory/Inbox/pending-memory.md`). Direct writes are never exposed over the network, even when `allowDirectWrites` is on. |
| `get_project_context` | Concatenated project memory (overview → architecture → decisions → tasks → open questions). | |
| `get_global_context` | Concatenated global memory (profile + preferences + conventions). | |
| `list_projects` | Project names under the projects root. | |
| `get_recent_sessions` | Most recent session notes for a project. | Limit capped at 20. |
| `reindex_vault` | Rebuild the index from the vault. | **Rate-limited** (15 s cooldown). Refused when indexing is disabled. |
| `summarize_note` | Extractive summary of an indexed note. | Inputs: `path` (required), `maxSentences` (optional, default 5, max 20). Returns a selection of the note's **own sentences** — verbatim, in original order — never generated prose. **In-scope only**: refused for notes that are not in the index. **Rate-limited** (30/min). |

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
  `allowNonLocalhost` opt-in **and** a token, or the server refuses to start.
- **Constant-time token auth.** Tokens are compared via SHA-256 digest +
  `timingSafeEqual`, so response timing does not leak the token. Auth is checked
  before the request body is read.
- **DNS-rebinding protection.** The `Host` header must be loopback or the bound
  host; any `Origin` header must be a loopback origin. Only a genuinely absent
  `Origin` passes (non-browser clients send none); opaque browser origins
  (`Origin: null`) are rejected. Foreign values get `403`.
- **Request hardening.** `POST`-only (`405` otherwise), JSON content-type
  required (`415` otherwise), a **1 MB body cap** (`413`), and a **32-message
  cap on JSON-RPC batches** (`400`) so a single request can't monopolize the
  event loop.
- **Query-scoped only.** No arbitrary file access; the full vault is never
  returned wholesale.
- **Inbox-first writes.** `add_memory` never overwrites and never writes
  directly over the network.
- **Rate-limited operations.** `reindex_vault` has a 15 s cooldown;
  `search_vault_memory` and `add_memory` have per-minute sliding-window caps, and
  `summarize_note` is capped at 30/min, to bound sustained flooding.
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
