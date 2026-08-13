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
import { redactAbsolutePaths } from "../src/utils/errors";

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
    // A URL's "//" follows a colon, which is not an accepted leading character.
    expect(redactAbsolutePaths("endpoint http://127.0.0.1:11434/api/embed refused")).toBe(
      "endpoint http://127.0.0.1:11434/api/embed refused",
    );
    expect(redactAbsolutePaths("Use / to separate segments")).toBe("Use / to separate segments");
  });
});
