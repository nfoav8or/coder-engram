# Security model

Claude Code Engram is local-first and privacy-preserving by default. It requires no cloud service or API key, keeps every read and write inside the active vault, and defaults to reviewable, append-only memory writes.

## Principles

1. **Everything stays inside the vault.** All plugin-managed memory lives under the configured memory root (default `Claude Code/`) inside the active Obsidian vault. The plugin never writes to arbitrary filesystem locations.
2. **One path choke-point.** `resolveInVault` (in `src/utils/paths.ts`) is the single function every memory read/write routes through. It normalizes vault-relative paths, resolves `.`/`..`, and throws `PathSecurityError` on anything absolute, drive/UNC-rooted, containing control characters, or escaping its root via `..`. `isInsideRoot` uses segment-boundary comparison, so `Claude Codex` is not treated as inside `Claude Code`.
3. **Defense in depth at the boundary.** Every `VaultAdapter` method also calls `assertRelative` and refuses absolute paths, even though callers are expected to sanitize first.
4. **Writes are reviewable by default.** Proposed memory is appended to the review inbox (`Memory/Inbox/pending-memory.md`), not written into your notes. You apply or discard entries by hand.
5. **Direct writes are double-gated.** `MemoryWriter.directWrite` throws unless `allowDirectWrites` is enabled *and* the target resolves inside the memory root; with `appendOnly` on it only ever appends.
6. **The server is off by default.** No network listener exists in M1. When the server ships (M2) it is disabled by default, binds to `127.0.0.1`, and uses token auth.
7. **Secrets never reach the console.** Debug logging is off by default. When on, the logger recursively redacts any context value whose key looks like a secret (`token`, `secret`, `apikey`, `api_key`, `authorization`, `password`, `bearer`).

## Safe defaults

| Setting | Default | Why it is safe |
| --- | --- | --- |
| `memoryRoot` | `Claude Code` | Inside the vault; validated on entry. |
| `server.enabled` | `false` | No network listener unless you opt in. |
| `server.host` | `127.0.0.1` | Localhost only; not reachable from the network. |
| `server.token` | *(empty)* | You set a strong token before enabling the server (M2). |
| `allowDirectWrites` | `false` | All writes go to the review inbox. |
| `appendOnly` | `true` | Memory is never overwritten in place. |
| `debugLogging` | `false` | No console noise; secrets redacted when enabled. |
| `embeddingProvider` | `none` | Works fully offline with lexical search; no external calls. |

## Sensitive-note controls

You can keep notes out of the index entirely with **Excluded folders**, **Excluded tags**, and **Excluded path patterns** (glob or substring). These filters run in the vault scanner before content is read where possible. Retrieval also only ever returns chunks that were indexed, so excluded notes cannot surface in search results.

## Risks of enabling direct writes

Turning on **Allow direct memory writes** lets tools (and, in M2, the server) modify memory files without going through the review inbox. Even then, writes are constrained to inside the memory root, and with **Append-only writes** on (the default) existing content is never overwritten. If you additionally turn *off* append-only, non-destructive behavior is lost and a bad write could replace an existing memory file's contents. Recommendation: leave direct writes off, or keep append-only on if you enable them.

## Risks of enabling the local server (M2, not yet implemented)

The local server (Milestone 2) will let external tools query and propose memory over HTTP. When it ships:

- Keep it bound to `127.0.0.1`. Binding to a non-localhost address exposes your memory to anyone on your network; the settings UI warns before you do this.
- Set a strong token. The token gates every request.
- Enable it only while you need it, and disable it afterward.
- Writes will remain inbox-first unless you have also enabled direct writes.

No server binary exists in M1, so none of these risks are live yet. See [MCP_SERVER.md](MCP_SERVER.md) for the planned design.
