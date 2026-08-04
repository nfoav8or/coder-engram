# Claude Code integration

> **The local server ships in Milestone 2.** You can now connect Claude Code to
> the plugin over a local, token-authenticated MCP endpoint — or keep using the
> plugin entirely through Obsidian and the Markdown memory folder. Both work.

## Build and install the plugin

1. Build the outputs:

   ```bash
   npm install
   npm run build
   ```

2. Copy `main.js`, `manifest.json`, and `styles.css` into your vault:

   ```
   <vault>/.obsidian/plugins/coder-engram/
   ```

3. In Obsidian, enable **Coder Engram** under Settings → Community plugins.

See [DEVELOPMENT.md](DEVELOPMENT.md) for a watch-build workflow.

## Option A — connect over the local MCP server (M2)

### 1. Enable the server in Obsidian

In **Settings → Local server**:

- Click **Generate** to create a token, then turn **Enable local server** on.
- Leave the host at `127.0.0.1` and the port at `3999` unless you have a reason
  to change them.
- The control panel (brain-circuit ribbon icon) shows `running · 127.0.0.1:3999`.

### 2. Register it with Claude Code

The server is a standard HTTP MCP endpoint. Add it to Claude Code with either
the CLI or your MCP config file. Use the token you generated:

```bash
claude mcp add --transport http coder-engram http://127.0.0.1:3999 \
  --header "Authorization: Bearer <your-token>"
```

Or, in an MCP JSON config:

```json
{
  "mcpServers": {
    "coder-engram": {
      "type": "http",
      "url": "http://127.0.0.1:3999",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

> Flag and field names vary slightly across Claude Code versions — check
> `claude mcp add --help` for yours. The endpoint accepts JSON-RPC 2.0 over
> `POST` at the base URL, which is what the `http` transport uses.

### 3. Available tools

Once connected, Claude Code can call:

- `search_vault_memory` — query-scoped retrieval (lexical by default, vector/hybrid
  when embeddings are configured): note paths, headings, line ranges, snippets;
  near-duplicates collapsed when **Context savings** is enabled (off by default),
  inbox hits labelled pending.
- `get_note_context` — the full **indexed** text of one note, passage by passage;
  pass a search hit's `startLine`/`endLine` to read just that region.
- `find_related_notes` — link-graph neighbours of an indexed note (links out + backlinks).
- `add_memory` — propose a memory entry (appended to the review inbox, de-duplicated).
- `get_project_context` / `get_global_context` — concatenated memory reads.
- `list_projects`, `get_recent_sessions` — project navigation.
- `reindex_vault` — rebuild the index (rate-limited).
- `summarize_note` — extractive summary of an in-index note (its own sentences, default 5 / max 20).

Full descriptions and the security model are in [MCP_SERVER.md](MCP_SERVER.md).

### A typical agent loop

- **Start of task:** call `get_global_context` and `get_project_context` for the
  project you are working in to prime Claude Code with durable memory.
- **During work:** call `search_vault_memory` to pull in relevant prior notes,
  decisions, and session history.
- **To read a hit in depth:** pass its path and line range to `get_note_context`
  for the full passage (a search result is only a snippet), and walk
  `find_related_notes` to reach linked decisions and follow-ups.
- **When something is worth remembering:** call `add_memory`. It lands in
  `Claude Code/Memory/Inbox/pending-memory.md` for you to review in Obsidian —
  nothing is overwritten, and nothing is applied without your say-so. Until you
  accept it, search returns it labelled `[PENDING REVIEW]`, so the agent never
  mistakes its own proposal for settled memory.

## Option B — use the Markdown folder directly (no server)

Everything works without the server, entirely inside your vault.

### Bootstrap a project

- Run **Coder Engram: Create Project Memory Folder** and name your project.
  This scaffolds `Claude Code/Memory/Projects/<name>/` with `overview.md`,
  `architecture.md`, `decisions.md`, `tasks.md`, `open-questions.md`, and a
  `sessions/` folder. Existing files are never overwritten.
- Set the project as your **Default project** in settings so the project-context
  and add-to-project commands target it.

### Capture and retrieve memory

- **Add Memory** appends a reviewable block to the inbox by default.
- **Review Pending Memory** lets you apply or discard inbox blocks by hand.
- **Reindex Vault** + **Search Memory** run BM25 retrieval and return note
  paths, headings, and snippets.
- **Start / End Session Note** create and close timestamped session notes.

When there is no server, have Claude Code read the relevant Markdown files
(project `overview.md`, `decisions.md`, session notes, the inbox) directly, and
write proposed memory back as Markdown for you to review in Obsidian.

## Security notes

- All memory stays inside your vault; the plugin never writes elsewhere.
- The server is **disabled by default**, **localhost-bound**, and
  **token-gated**. Binding a non-localhost address requires an explicit opt-in
  **and** a token. Never bind it to a public interface.
- Over the server, `add_memory` is **inbox-only** — direct writes are never
  exposed to the network, even if you have enabled direct writes for the UI.
- Direct writes (UI) are off by default; keep append-only on to avoid
  overwriting memory. See [SECURITY.md](SECURITY.md) for the full model.
