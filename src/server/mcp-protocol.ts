/**
 * server/mcp-protocol — JSON-RPC 2.0 dispatch implementing the MCP methods the
 * plugin supports: `initialize`, `notifications/initialized`, `ping`,
 * `tools/list`, `tools/call`.
 *
 * This layer is transport-agnostic and pure: it takes an already-parsed message
 * and returns a response object (or null for notifications). The HTTP shell in
 * local-server.ts handles sockets, auth, and JSON (de)serialization.
 *
 * Error conventions:
 *   - Malformed requests / unknown methods → JSON-RPC error objects.
 *   - Tool execution failures → a normal result with `isError: true` and the
 *     message in the content (the MCP-idiomatic in-band error), so a failing
 *     tool never looks like a transport fault to the client.
 */

import { ToolRegistry, ToolContext } from "./mcp-tools";
import { toMessage } from "../utils/errors";
import { isPlainObject } from "../utils/validation";
import { Logger } from "../utils/logger";

/** Protocol version we advertise; we echo the client's if it sends a string. */
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface ProtocolDeps {
  registry: ToolRegistry;
  toolContext: ToolContext;
  serverInfo: { name: string; version: string };
  logger: Logger;
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

/**
 * Dispatch a single parsed JSON-RPC message. Returns null when the message is a
 * notification (no `id`), meaning no response should be sent.
 */
export async function handleRpcMessage(
  message: unknown,
  deps: ProtocolDeps,
): Promise<JsonRpcResponse | null> {
  if (!isPlainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    // For an unparseable/invalid request we still owe a response with null id.
    const id = isPlainObject(message) && isId(message.id) ? message.id : null;
    return fail(id, JsonRpcErrorCode.InvalidRequest, "Invalid JSON-RPC 2.0 request.");
  }

  const method = message.method;
  const hasId = isId(message.id);
  const id = hasId ? (message.id as string | number) : null;
  const params = message.params;

  // Notifications (no id) never get a response.
  const isNotification = !hasId;

  // These are request methods; per JSON-RPC a notification (no id) gets no
  // response at all, even for otherwise-valid calls.
  if (isNotification && method !== "notifications/initialized" && method !== "initialized" && method !== "ping") {
    return null;
  }

  try {
    switch (method) {
      case "initialize": {
        const requested = isPlainObject(params) && typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION;
        return ok(id, {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: deps.serverInfo,
        });
      }

      case "notifications/initialized":
      case "initialized":
        // Client handshake completion — a notification; acknowledge silently.
        return isNotification ? null : ok(id, {});

      case "ping":
        return isNotification ? null : ok(id, {});

      case "tools/list":
        return ok(id, { tools: deps.registry.list() });

      case "tools/call": {
        if (!isPlainObject(params) || typeof params.name !== "string") {
          return fail(id, JsonRpcErrorCode.InvalidParams, "tools/call requires a string 'name'.");
        }
        const toolName = params.name;
        const args = params.arguments ?? {};
        try {
          const text = await deps.registry.call(toolName, args, deps.toolContext);
          return ok(id, { content: [{ type: "text", text }], isError: false });
        } catch (err) {
          // Tool-level failure: report in-band so the client sees the reason.
          deps.logger.warn("Tool call failed", { tool: toolName, error: toMessage(err) });
          return ok(id, {
            content: [{ type: "text", text: `Error: ${toMessage(err)}` }],
            isError: true,
          });
        }
      }

      default:
        if (isNotification) return null;
        return fail(id, JsonRpcErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
  } catch (err) {
    deps.logger.error("RPC dispatch error", { method, error: toMessage(err) });
    if (isNotification) return null;
    return fail(id, JsonRpcErrorCode.InternalError, "Internal error.");
  }
}

function isId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
