import { describe, it, expect } from "vitest";
import { EngramEngine } from "../src/engine";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import { NULL_LOGGER } from "../src/utils/logger";
import { ToolRegistry, ToolContext, RateLimiter } from "../src/server/mcp-tools";
import {
  handleRpcMessage,
  ProtocolDeps,
  JsonRpcErrorCode,
  DEFAULT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "../src/server/mcp-protocol";
import { asError, PathSecurityError, redactAbsolutePaths } from "../src/utils/errors";

function makeDeps(seed: Record<string, string> = {}): ProtocolDeps {
  const adapter = new InMemoryVaultAdapter("v", seed);
  const settings = { ...DEFAULT_SETTINGS };
  let t = 1_000;
  const clock = () => t++;
  const engine = new EngramEngine(adapter, settings, NULL_LOGGER, clock);
  const toolContext: ToolContext = {
    engine,
    settings,
    logger: NULL_LOGGER,
    clock,
    rateLimiter: new RateLimiter(clock),
  };
  return {
    registry: new ToolRegistry(),
    toolContext,
    serverInfo: { name: "coder-engram", version: "0.1.0" },
    logger: NULL_LOGGER,
  };
}

describe("handleRpcMessage", () => {
  it("responds to initialize with server info and capabilities", async () => {
    const res = await handleRpcMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      makeDeps(),
    );
    expect(res?.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "coder-engram" },
    });
  });

  it("defaults the protocol version when the client omits it", async () => {
    const res = await handleRpcMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, makeDeps());
    expect((res?.result as { protocolVersion: string }).protocolVersion).toBe(DEFAULT_PROTOCOL_VERSION);
  });

  it("agrees to an older protocol revision it actually implements", async () => {
    // The four methods this server implements are wire-identical across these
    // revisions, so an older client keeps working rather than being told to
    // disconnect.
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      const res = await handleRpcMessage(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version } },
        makeDeps(),
      );
      expect((res?.result as { protocolVersion: string }).protocolVersion).toBe(version);
    }
  });

  it("answers a version it does not speak with its own, rather than agreeing to anything", async () => {
    // Echoing the request would promise a revision this server has never
    // implemented; the spec wants our latest instead, and lets the client
    // decide whether to disconnect.
    for (const version of ["2026-07-28", "2025-11-25", "not-a-version", ""]) {
      const res = await handleRpcMessage(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version } },
        makeDeps(),
      );
      expect((res?.result as { protocolVersion: string }).protocolVersion).toBe(DEFAULT_PROTOCOL_VERSION);
    }
  });

  it("lists tools", async () => {
    const res = await handleRpcMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, makeDeps());
    const tools = (res?.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("search_vault_memory");
  });

  it("returns null for a notification (no id)", async () => {
    const res = await handleRpcMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, makeDeps());
    expect(res).toBeNull();
  });

  it("errors rather than hangs when an id member is present but malformed", async () => {
    // A Notification is a request WITHOUT an id member. `"id": null` (or a
    // boolean/object/NaN) is a malformed REQUEST and owes an error response —
    // treating it as a notification means a client that sent one waits forever
    // for a reply the server silently decided not to send.
    for (const badId of [null, true, {}, [], Number.NaN]) {
      const res = await handleRpcMessage(
        { jsonrpc: "2.0", id: badId, method: "tools/list" },
        makeDeps(),
      );
      expect(res, `id ${JSON.stringify(badId)} must get a response`).not.toBeNull();
      expect(res?.error?.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(res?.id).toBeNull();
    }
  });

  it("still treats a genuinely absent id as a notification", async () => {
    const res = await handleRpcMessage({ jsonrpc: "2.0", method: "tools/list" }, makeDeps());
    expect(res).toBeNull();
  });

  it("returns null when a request-only method is sent as a notification", async () => {
    // No id => notification => no response, even for tools/list or tools/call.
    expect(await handleRpcMessage({ jsonrpc: "2.0", method: "tools/list" }, makeDeps())).toBeNull();
    expect(
      await handleRpcMessage(
        { jsonrpc: "2.0", method: "tools/call", params: { name: "list_projects", arguments: {} } },
        makeDeps(),
      ),
    ).toBeNull();
  });

  it("does not RUN a write tool sent as a notification, not merely stay silent", async () => {
    // The check above proves the response is null. That is the cheap half: a
    // read-only tool executing unnoticed changes nothing. What must hold is
    // that the tool never runs, because a notification has no id and so no
    // reply — an executed `add_memory` would be a fire-and-forget write with
    // nothing for the client to correlate it to. Restructuring this into
    // "execute, then return null for notifications" reads as a faithful
    // implementation of the JSON-RPC rule and would pass the other test.
    const deps = makeDeps();
    const res = await handleRpcMessage(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "add_memory", arguments: { content: "fire and forget" } },
      },
      deps,
    );
    expect(res).toBeNull();
    const inbox = await deps.toolContext.engine.getPendingMemory();
    expect(inbox.entries).toHaveLength(0);
  });

  it("calls a tool and returns text content", async () => {
    const deps = makeDeps();
    await deps.toolContext.engine.ensureScaffold();
    await deps.toolContext.engine.createProject("Demo");
    const res = await handleRpcMessage(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_global_context", arguments: {} } },
      deps,
    );
    const result = res?.result as { content: { type: string; text: string }[]; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("Profile");
  });

  it("omits structuredContent for a tool that emits none", async () => {
    // Emitting an empty object would be a claim the tool made a structured
    // answer; a client validating against the (absent) outputSchema would be
    // right to object.
    const deps = makeDeps();
    await deps.toolContext.engine.ensureScaffold();
    const res = await handleRpcMessage(
      { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "get_global_context", arguments: {} } },
      deps,
    );
    expect(Object.keys(res?.result as object)).not.toContain("structuredContent");
  });

  it("puts structuredContent alongside the text, never instead of it", async () => {
    const deps = makeDeps();
    await deps.toolContext.engine.createProject("Demo");
    const res = await handleRpcMessage(
      { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "list_projects", arguments: {} } },
      deps,
    );
    const result = res?.result as {
      content: { type: string; text: string }[];
      structuredContent: { projects: string[] };
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    // A client that ignores structuredContent must lose nothing.
    expect(result.content[0].text).toContain("Demo");
    expect(result.structuredContent.projects).toContain("Demo");
  });

  it("advertises outputSchema on tools/list for the tools that emit one", async () => {
    const res = await handleRpcMessage(
      { jsonrpc: "2.0", id: 32, method: "tools/list" },
      makeDeps(),
    );
    const tools = (res?.result as { tools: { name: string; outputSchema?: unknown }[] }).tools;
    expect(tools.find((t) => t.name === "list_projects")?.outputSchema).toBeDefined();
    expect(tools.find((t) => t.name === "get_global_context")?.outputSchema).toBeUndefined();
  });

  it("reports tool failures in-band via isError, not a transport error", async () => {
    const res = await handleRpcMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_vault_memory", arguments: {} } },
      makeDeps(),
    );
    expect(res?.error).toBeUndefined();
    const result = res?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Error/);
  });

  it("returns InvalidParams when tools/call lacks a name", async () => {
    const res = await handleRpcMessage(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: {} },
      makeDeps(),
    );
    expect(res?.error?.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it("returns MethodNotFound for an unknown method", async () => {
    const res = await handleRpcMessage({ jsonrpc: "2.0", id: 6, method: "does/not/exist" }, makeDeps());
    expect(res?.error?.code).toBe(JsonRpcErrorCode.MethodNotFound);
  });

  it("rejects a non-JSON-RPC-2.0 message", async () => {
    const res = await handleRpcMessage({ id: 7, method: "ping" }, makeDeps());
    expect(res?.error?.code).toBe(JsonRpcErrorCode.InvalidRequest);
  });

  /**
   * A tool failure is reported in-band so the client can act on it, which makes
   * the message text an output channel. Errors thrown beneath the plugin —
   * Node's `fs`, Obsidian's adapter — name the vault's absolute location, and
   * with it the account name and the vault's real folder name. No tool
   * discloses those, so an error must not either.
   */
  it("keeps the vault's absolute location out of a tool failure", async () => {
    const secret = "/home/realuser/Private Vault/Финансы/salary.md";
    class ExplodingVault extends InMemoryVaultAdapter {
      async write(): Promise<void> {
        throw new Error(`EACCES: permission denied, open '${secret}'`);
      }
    }
    const adapter = new ExplodingVault("v", {});
    const settings = { ...DEFAULT_SETTINGS };
    let t = 1_000;
    const clock = () => t++;
    const engine = new EngramEngine(adapter, settings, NULL_LOGGER, clock);
    const deps: ProtocolDeps = {
      registry: new ToolRegistry(),
      toolContext: { engine, settings, logger: NULL_LOGGER, clock, rateLimiter: new RateLimiter(clock) },
      serverInfo: { name: "coder-engram", version: "0.1.0" },
      logger: NULL_LOGGER,
    };

    const res = await handleRpcMessage(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "add_memory", arguments: { content: "a memory", project: "proj" } },
      },
      deps,
    );
    const result = res?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    // The failure is still reported — only the host path is withheld.
    expect(result.content[0].text).toContain("EACCES");
    expect(result.content[0].text).not.toContain("realuser");
    expect(result.content[0].text).not.toContain("Финансы");
  });
});

describe("asError", () => {
  it("returns an existing Error unchanged so subclass identity survives a rethrow", () => {
    const original = new PathSecurityError("nope");
    expect(asError(original)).toBe(original);
    expect(asError(original)).toBeInstanceOf(PathSecurityError);
  });

  it("wraps a non-Error rejection so callers that assume Error still work", () => {
    // Host APIs and companion plugins can reject with a bare string or object.
    // A bare `throw err` propagated that value untouched to callers that all
    // treat a failure as an Error, losing the message on the way out.
    expect(asError("disk full")).toBeInstanceOf(Error);
    expect(asError("disk full").message).toBe("disk full");
    expect(asError({ code: 42 })).toBeInstanceOf(Error);
    expect(asError(undefined).message).toBe("Unknown error");
  });
});

describe("redactAbsolutePaths", () => {
  it("removes a host path in every shape an error reports one", () => {
    // The POSIX case is quoted and contains a space: a whitespace-delimited
    // match would stop at "Private" and leak the rest of the path.
    expect(redactAbsolutePaths("open '/home/u/Private Vault/x.md'")).toBe("open '<path>'");
    expect(redactAbsolutePaths('open "C:\\Users\\Real Name\\v.md"')).toBe('open "<path>"');
    expect(redactAbsolutePaths("scandir /Users/u/Vault")).toBe("scandir <path>");
    expect(redactAbsolutePaths("failed on \\\\nas01\\share\\v.md")).toBe("failed on <path>");
  });

  it("leaves everything the client is entitled to read", () => {
    // Vault-relative paths never begin with a separator, so they survive.
    expect(redactAbsolutePaths('Note "Projects/Work.md" is not indexed')).toBe(
      'Note "Projects/Work.md" is not indexed',
    );
    expect(redactAbsolutePaths("Ollama embed failed (HTTP 500)")).toBe(
      "Ollama embed failed (HTTP 500)",
    );
    // A URL is matched as a URL, ahead of the bare-path form, and kept.
    expect(redactAbsolutePaths("endpoint http://127.0.0.1:11434/api/embed refused")).toBe(
      "endpoint http://127.0.0.1:11434/api/embed refused",
    );
    expect(redactAbsolutePaths("Use / to separate segments")).toBe("Use / to separate segments");
  });

  it("redacts a path after any separator, not just the four once allowed", () => {
    // The bare form used to be recognized only after start-of-string,
    // whitespace, "(", "[" or "<". That allowlist existed to keep the scan off
    // the "//" in "https://", but it also excluded every other separator a real
    // host error uses — so each of these carried the vault's absolute location,
    // and with it the account name and the vault's real folder name, to any MCP
    // client that provoked the error.
    expect(redactAbsolutePaths("error:/home/u/Vault/x.md")).toBe("error:<path>");
    expect(redactAbsolutePaths("path=/home/u/Vault/x.md")).toBe("path=<path>");
    expect(redactAbsolutePaths("files: a,/home/u/Vault/x.md")).toBe("files: a,<path>");
    // Quotes that do not match are not a quoted path; the bare form must still
    // catch it rather than each form assuming the other did.
    expect(redactAbsolutePaths("open '/home/u/Vault/x.md\"")).toBe("open '<path>\"");
    // A file:// URI names a local path as surely as a bare one does. Every
    // other scheme is a URL and is kept.
    expect(redactAbsolutePaths("failed: file:///home/u/Vault/x.md")).toBe("failed: <path>");
  });

  it("still refuses to read a vault-relative path as an absolute one", () => {
    // The one thing the old leading allowlist really bought: the "/" inside
    // "Notes/private.md" must not be read as the start of an absolute path.
    // Widening the accepted separators without stating this exclusion redacted
    // every vault-relative path in every error, which is the namespace the
    // caller is entitled to and needs in order to act.
    expect(redactAbsolutePaths('Note "Notes/private.md" is not indexed')).toBe(
      'Note "Notes/private.md" is not indexed',
    );
    expect(redactAbsolutePaths("read Projects/Work/notes.md failed")).toBe(
      "read Projects/Work/notes.md failed",
    );
  });
});
