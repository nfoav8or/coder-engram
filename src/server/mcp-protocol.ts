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
import { toClientMessage, toMessage } from "../utils/errors";
import { isPlainObject } from "../utils/validation";
import { Logger } from "../utils/logger";

/** Protocol version we advertise when the client asks for one we don't speak. */
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/**
 * Versions this server will negotiate, latest first.
 *
 * The 2025-06-18 lifecycle spec: "If the server supports the requested protocol
 * version, it MUST respond with the same version. Otherwise, the server MUST
 * respond with another protocol version it supports. This SHOULD be the latest
 * version supported by the server." — so an unknown version gets
 * DEFAULT_PROTOCOL_VERSION (the first entry here), and the client decides
 * whether it can live with that.
 *
 * The two older revisions are listed because the four methods this server
 * implements — initialize, ping, tools/list, tools/call — are wire-identical
 * across them: same `inputSchema` on a tool, same `content` array and `isError`
 * on a result, same `nextCursor` paging. 2025-06-18 added `outputSchema` and
 * `structuredContent`, which are optional and which this server does not emit.
 *
 * Newer revisions are deliberately absent. They replaced this negotiation with
 * an `UnsupportedProtocolVersionError`, so answering one would claim a revision
 * this server does not implement.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  DEFAULT_PROTOCOL_VERSION,
  "2025-03-26",
  "2024-11-05",
];

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
  // "no id member" and "an id member that is not a valid id" are different
  // things. Per JSON-RPC 2.0 a Notification is a request object WITHOUT an id;
  // a message carrying `"id": null` (or a boolean/object/NaN) is a malformed
  // REQUEST and owes an error response. Collapsing the two meant such a client
  // got no reply at all and simply hung, waiting on a response the server had
  // silently decided not to send.
  const idPresent = "id" in message;
  const hasId = isId(message.id);
  if (idPresent && !hasId) {
    return fail(null, JsonRpcErrorCode.InvalidRequest, "Request id must be a string or a finite number.");
  }
  const id = hasId ? (message.id as string | number) : null;
  const params = message.params;

  // Notifications (no id member) never get a response.
  const isNotification = !idPresent;

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
        // Echoing whatever the client named would claim support for revisions
        // this server has never implemented, and the client would then proceed
        // on that promise.
        const agreed = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : DEFAULT_PROTOCOL_VERSION;
        return ok(id, {
          protocolVersion: agreed,
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
            content: [{ type: "text", text: `Error: ${toClientMessage(err)}` }],
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
