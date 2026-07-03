# Claude Code integration

> **Server integration arrives in Milestone 2.** The programmatic connection between Claude Code and the plugin depends on the local MCP/HTTP server, which is **not yet implemented** (see [MCP_SERVER.md](MCP_SERVER.md)). Today you use Claude Code Engram through Obsidian commands and by reading/writing the Markdown memory folder directly. This document covers the current workflow and shows the forward-looking MCP config for when M2 lands.

## Build and install the plugin

1. Build the outputs:

   ```bash
   npm install
   npm run build
   ```

2. Copy `main.js`, `manifest.json`, and `styles.css` into your vault:

   ```
   <vault>/.obsidian/plugins/claude-code-engram/
   ```

3. In Obsidian, enable **Claude Code Engram** under Settings → Community plugins.

See [DEVELOPMENT.md](DEVELOPMENT.md) for a watch-build workflow.

## The memory workflow you can use today

Everything below works now, without a server, entirely inside your vault.

### Bootstrap a project

- Run **Claude Code Engram: Create Project Memory Folder** and name your project. This scaffolds `Claude Code/Memory/Projects/<name>/` with `overview.md`, `architecture.md`, `decisions.md`, `tasks.md`, `open-questions.md`, and a `sessions/` folder. Existing files are never overwritten.
- Set the project as your **Default project** in settings so the project-context and add-to-project commands target it.

### Capture memory

- **Claude Code Engram: Add Memory** opens a form; the entry is appended (as a reviewable block) to `Claude Code/Memory/Inbox/pending-memory.md` by default.
- **Claude Code Engram: Add Current Note to Project Memory** seeds an Add Memory entry linked to the active note.
- **Claude Code Engram: Review Pending Memory** lets you review inbox blocks; apply or discard them by hand. Because writes are inbox-first and append-only by default, nothing overwrites your notes.

### Record sessions and decisions

- **Start Session Note** / **End Session Note** create and close timestamped session notes under a project's `sessions/` folder.
- Record decisions and open questions directly in the project's `decisions.md` and `open-questions.md`.

### Retrieve context

- **Reindex Vault** builds the local index; **Search Memory** runs BM25 lexical retrieval and returns note paths, headings, and snippets.
- **Show Project Context** displays the concatenated project memory.

### Using this with Claude Code manually

Since there is no server yet, the practical pattern today is: keep your memory in the `Claude Code/` folder, and have Claude Code read the relevant Markdown files (project `overview.md`, `decisions.md`, session notes, the inbox) as part of its context, and write proposed memory back as Markdown for you to review in Obsidian. The plugin keeps that folder structured, safe, and searchable.

## Forward-looking: MCP config (Milestone 2)

Once the local server ships, you will enable it in settings (localhost, a port, and a token) and register it with Claude Code. The configuration will look approximately like this — **it does not work yet**:

```json
{
  "mcpServers": {
    "claude-code-engram": {
      "type": "http",
      "url": "http://127.0.0.1:3999",
      "headers": {
        "Authorization": "Bearer <your-configured-token>"
      }
    }
  }
}
```

Planned tools (e.g. `search_vault_memory`, `add_memory`, `get_project_context`) and the security model are described in [MCP_SERVER.md](MCP_SERVER.md) and [SECURITY.md](SECURITY.md). The exact connection format will be finalized when the server is implemented.

## Security notes

- All memory stays inside your vault; the plugin never writes elsewhere.
- The server, when it exists, will be disabled by default, localhost-bound, and token-gated. Never bind it to a public interface.
- Direct writes are off by default. Leave them off, or keep append-only on, to avoid overwriting memory. See [SECURITY.md](SECURITY.md) for the full model and the risks of enabling direct writes or the server.
