/**
 * server/local-server — the thin Node HTTP shell around the pure MCP layers.
 *
 * This is the ONLY server file that touches sockets (`node:http`). It owns:
 *   - binding (localhost by default; non-loopback refused without explicit
 *     opt-in AND a token),
 *   - DNS-rebinding protection (Host/Origin validation),
 *   - request hardening (POST-only, JSON content-type, body-size cap),
 *   - token auth (constant-time), and
 *   - handing the parsed JSON-RPC message to the transport-agnostic dispatcher.
 *
 * Everything security-relevant that can be tested without a socket lives in
 * auth.ts, net.ts, mcp-protocol.ts and mcp-tools.ts; this file stays a thin,
 * auditable shell.
 */

import * as http from "node:http";

import { EngramEngine } from "../engine";
import { EngramSettings } from "../settings/settings";
import { Logger } from "../utils/logger";
import { toMessage, ConfigError } from "../utils/errors";
import { assertValidPort } from "../utils/validation";
import { checkAuth } from "./auth";
import { isLoopbackHost, isHostHeaderAllowed, isOriginAllowed } from "./net";
import { ToolRegistry, ToolContext, RateLimiter } from "./mcp-tools";
import {
  handleRpcMessage,
  JsonRpcResponse,
  JsonRpcErrorCode,
  ProtocolDeps,
} from "./mcp-protocol";

const MAX_BODY_BYTES = 1_000_000; // 1 MB cap on a single request body.
const MAX_BATCH_SIZE = 32; // cap JSON-RPC batch length to bound per-request work.
const LISTEN_TIMEOUT_MS = 5_000;

export interface LocalServerOptions {
  engine: EngramEngine;
  logger: Logger;
  serverInfo: { name: string; version: string };
  clock?: () => number;
}

export interface ServerAddress {
  host: string;
  port: number;
}

export class LocalServer {
  private server: http.Server | null = null;
  private address: ServerAddress | null = null;
  /** Settings SNAPSHOT taken at the last start() (deep-copied): the host
   * mutates its one live settings object per keystroke in the settings tab,
   * so auth and the tools must see committed state — never a half-typed
   * token — and the handler reads this field, not a live reference. */
  private settings: EngramSettings | null = null;
  /** Server sub-config the current listener was bound with. */
  private boundConfigKey = "";
  private readonly registry = new ToolRegistry();
  private readonly rateLimiter: RateLimiter;
  private readonly clock: () => number;
  // Serializes start/stop so overlapping settings changes or a double-invoked
  // "Restart" command can never bind two listeners or leak a port.
  private lifecycle: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: LocalServerOptions) {
    this.clock = opts.clock ?? (() => Date.now());
    this.rateLimiter = new RateLimiter(this.clock);
  }

  /** Run a lifecycle operation after any in-flight start/stop completes. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(op, op);
    // Keep the chain alive regardless of this op's outcome; callers handle errors.
    this.lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  getAddress(): ServerAddress | null {
    return this.address;
  }

  /**
   * Validate the server configuration WITHOUT binding. Returns the intended
   * bind address or throws ConfigError with a clear, user-actionable message.
   * Exposed so the settings UI can warn before enabling.
   */
  static validateConfig(settings: EngramSettings): ServerAddress {
    const s = settings.server;
    const host = (s.host || "127.0.0.1").trim();
    // Port 0 is a valid request meaning "let the OS assign a free port"; the
    // actual bound port is reported back via getAddress().
    const rawPort = Math.trunc(Number(s.port));
    const port = rawPort === 0 ? 0 : assertValidPort(rawPort);
    if (!isLoopbackHost(host)) {
      if (!s.allowNonLocalhost) {
        throw new ConfigError(
          `Refusing to bind non-localhost host "${host}". Enable "Allow non-localhost binding" ` +
            `to expose memory to the network (not recommended).`,
        );
      }
      if (s.token.trim() === "") {
        throw new ConfigError(
          `A token is required to bind a non-localhost host ("${host}"). Set a server token first.`,
        );
      }
    }
    return { host, port };
  }

  /** Start (or restart) the server with the given settings snapshot. */
  start(settings: EngramSettings): Promise<ServerAddress> {
    return this.enqueue(() => this.doStart(settings));
  }

  private async doStart(settings: EngramSettings): Promise<ServerAddress> {
    // Restarting is disruptive (kills in-flight requests), and the settings
    // tab commits on every edit — skip the rebind when the server sub-config
    // is unchanged. Non-server settings still take effect: the handler reads
    // `this.settings`, refreshed here.
    // Deep-copy: `settings` is the host's live object, mutated in place by the
    // settings tab per keystroke. Every field here is plain JSON data.
    const snapshot = JSON.parse(JSON.stringify(settings)) as EngramSettings;
    const configKey = JSON.stringify(snapshot.server);
    if (this.server && this.address && configKey === this.boundConfigKey) {
      this.settings = snapshot;
      return this.address;
    }

    // Serialized via enqueue(), so calling doStop() directly here is safe.
    if (this.server) await this.doStop();

    const address = LocalServer.validateConfig(snapshot);
    const nonLocal = !isLoopbackHost(address.host);
    const tokenSet = snapshot.server.token.trim() !== "";

    // Security-relevant startup event. Never logs the token itself.
    this.opts.logger.info("Starting local server", {
      host: address.host,
      port: address.port,
      auth: tokenSet ? "token" : "none",
      exposure: nonLocal ? "NON-LOCALHOST" : "localhost",
    });
    if (nonLocal) {
      this.opts.logger.warn("Local server is bound to a NON-LOCALHOST address — memory is reachable over the network.");
    }
    if (!tokenSet) {
      this.opts.logger.warn("Local server is running WITHOUT a token — any local process can query memory.");
    }

    const server = http.createServer((req, res) => {
      // Read the last COMMITTED snapshot so non-server settings changes (which
      // skip the rebind above) still reach auth and the tool context — while
      // in-flight edits to the host's live object never do.
      this.handleRequest(req, res, this.settings ?? snapshot, address.host).catch((err) => {
        this.opts.logger.error("Unhandled request error", { error: toMessage(err) });
        endJson(res, 500, { error: "Internal error." });
      });
    });

    await this.listen(server, address);
    // Persistent handler so a post-listen socket error (e.g. EMFILE on accept)
    // is logged rather than thrown as an unhandled 'error' event.
    server.on("error", (err) => {
      this.opts.logger.error("Server error", { error: toMessage(err) });
    });
    this.server = server;
    this.settings = snapshot;
    this.boundConfigKey = configKey;
    // Reflect the actually-bound port (in case port 0 was requested for tests).
    const bound = server.address();
    if (bound && typeof bound === "object") {
      this.address = { host: address.host, port: bound.port };
    } else {
      this.address = address;
    }
    return this.address;
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.doStop());
  }

  private async doStop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.address = null;
    this.settings = null;
    this.boundConfigKey = "";
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Force-close idle keep-alive sockets so close() resolves promptly.
      server.closeIdleConnections?.();
    });
    this.opts.logger.info("Local server stopped");
  }

  private listen(server: http.Server, address: ServerAddress): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        server.removeListener("error", onError);
        server.removeListener("listening", onListening);
        clearTimeout(timer);
      };
      const onError = (err: Error) => {
        cleanup();
        reject(new ConfigError(`Could not start server on ${address.host}:${address.port} — ${toMessage(err)}`));
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        // The bind may still be in flight; if it completes after we time out it
        // would become an untracked listener, so close it. Swallow any late
        // 'error' so it isn't thrown as an unhandled event.
        server.on("error", () => {});
        server.close(() => {});
        reject(new ConfigError(`Timed out binding ${address.host}:${address.port}.`));
      }, LISTEN_TIMEOUT_MS);
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(address.port, address.host);
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    settings: EngramSettings,
    boundHost: string,
  ): Promise<void> {
    // 1. Method: only POST carries JSON-RPC. We do not implement the SSE GET
    //    stream; reject everything else clearly.
    if (req.method !== "POST") {
      endJson(res, 405, { error: "Only POST is supported." });
      return;
    }

    // 2. DNS-rebinding protection: validate Host and Origin before anything else.
    if (!isHostHeaderAllowed(req.headers.host, boundHost)) {
      this.opts.logger.warn("Rejected request: bad Host header", { host: req.headers.host });
      endJson(res, 403, { error: "Forbidden host." });
      return;
    }
    if (!isOriginAllowed(req.headers.origin)) {
      this.opts.logger.warn("Rejected request: cross-origin", { origin: req.headers.origin });
      endJson(res, 403, { error: "Cross-origin requests are not allowed." });
      return;
    }

    // 3. Content-Type must be JSON (essence check — ignore any ;charset suffix).
    const contentType = (req.headers["content-type"] ?? "").toString().toLowerCase();
    const essence = contentType.split(";", 1)[0].trim();
    if (essence !== "application/json") {
      endJson(res, 415, { error: "Content-Type must be application/json." });
      return;
    }

    // 4. Auth (constant-time). Do this before reading the (potentially large) body.
    const decision = checkAuth(settings.server.token, req.headers.authorization);
    if (!decision.ok) {
      this.opts.logger.warn("Auth failed", { reason: decision.reason });
      res.setHeader("WWW-Authenticate", "Bearer");
      endJson(res, 401, { error: "Unauthorized." });
      return;
    }

    // 5. Read the body with a hard size cap.
    let body: string;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      endJson(res, 413, { error: toMessage(err) });
      return;
    }

    // 6. Parse JSON.
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      endJson(res, 400, rpcError(null, JsonRpcErrorCode.ParseError, "Parse error."));
      return;
    }

    // 7. Dispatch (single message or JSON-RPC batch).
    const deps = this.buildProtocolDeps(settings);
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        endJson(res, 400, rpcError(null, JsonRpcErrorCode.InvalidRequest, "Empty batch."));
        return;
      }
      if (parsed.length > MAX_BATCH_SIZE) {
        // Bound per-request work: a huge batch of synchronous searches would
        // otherwise freeze the event loop for the whole app.
        endJson(res, 400, rpcError(null, JsonRpcErrorCode.InvalidRequest, `Batch too large (max ${MAX_BATCH_SIZE}).`));
        return;
      }
      const responses = (await Promise.all(parsed.map((m) => handleRpcMessage(m, deps)))).filter(
        (r): r is JsonRpcResponse => r !== null,
      );
      if (responses.length === 0) {
        res.statusCode = 202; // all notifications
        res.end();
        return;
      }
      endJson(res, 200, responses);
      return;
    }

    const response = await handleRpcMessage(parsed, deps);
    if (response === null) {
      res.statusCode = 202; // a single notification
      res.end();
      return;
    }
    endJson(res, 200, response);
  }

  private buildProtocolDeps(settings: EngramSettings): ProtocolDeps {
    const toolContext: ToolContext = {
      engine: this.opts.engine,
      settings,
      logger: this.opts.logger.child("tools"),
      clock: this.clock,
      rateLimiter: this.rateLimiter,
    };
    return {
      registry: this.registry,
      toolContext,
      serverInfo: this.opts.serverInfo,
      logger: this.opts.logger.child("rpc"),
    };
  }
}

/**
 * Read a request body into a string, rejecting once it exceeds `maxBytes`.
 *
 * On overflow we STOP buffering but keep draining the stream (up to a hard
 * abuse cap of 10× the limit) so a merely-too-large client can finish sending
 * and still read a clean 413 response. A truly abusive stream is destroyed.
 */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  const hardCap = maxBytes * 10;
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        if (!over) {
          over = true;
          chunks.length = 0; // release what we buffered; we will reject
        }
        if (total > hardCap) {
          // Abusive stream: tear it down. 'close' (below) settles the promise.
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      done(() =>
        over ? reject(new BodyTooLargeError(maxBytes)) : resolve(Buffer.concat(chunks).toString("utf8")),
      );
    });
    req.on("error", (err) => done(() => reject(err)));
    req.on("aborted", () => done(() => reject(new Error("Request aborted."))));
    // Backstop: a destroyed stream emits 'close' but may emit neither 'end' nor
    // 'error', so ensure the promise always settles.
    req.on("close", () => {
      done(() =>
        reject(over ? new BodyTooLargeError(maxBytes) : new Error("Connection closed before body completed.")),
      );
    });
  });
}

class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes.`);
  }
}

function endJson(res: http.ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(body);
  } catch {
    // Socket already gone (client aborted) — nothing to send.
  }
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
