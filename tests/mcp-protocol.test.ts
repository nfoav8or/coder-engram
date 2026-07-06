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
} from "../src/server/mcp-protocol";

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
});
