import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { EngramEngine } from "../src/engine";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { DEFAULT_SETTINGS, EngramSettings } from "../src/settings/settings";
import { NULL_LOGGER } from "../src/utils/logger";
import { ConfigError } from "../src/utils/errors";
import { LocalServer } from "../src/server/local-server";

let running: LocalServer | null = null;

afterEach(async () => {
  if (running) {
    await running.stop();
    running = null;
  }
});

async function startServer(overrides: Partial<EngramSettings["server"]> = {}, seed: Record<string, string> = {}) {
  const adapter = new InMemoryVaultAdapter("v", seed);
  const settings: EngramSettings = {
    ...DEFAULT_SETTINGS,
    server: { ...DEFAULT_SETTINGS.server, enabled: true, host: "127.0.0.1", port: 0, ...overrides },
  };
  const engine = new EngramEngine(adapter, settings, NULL_LOGGER);
  await engine.reindex();
  const server = new LocalServer({
    engine,
    logger: NULL_LOGGER,
    serverInfo: { name: "claude-code-engram", version: "0.1.0" },
  });
  const addr = await server.start(settings);
  running = server;
  return { server, addr };
}

interface RawResponse {
  status: number;
  body: string;
}

function raw(
  port: number,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "POST",
        path: "/",
        headers: {
          "content-type": "application/json",
          ...opts.headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const RPC = (method: string, params?: unknown, id: number | string = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

describe("LocalServer.validateConfig", () => {
  const base = { ...DEFAULT_SETTINGS };

  it("accepts a localhost bind", () => {
    expect(() => LocalServer.validateConfig(base)).not.toThrow();
  });

  it("refuses a non-localhost host without explicit opt-in", () => {
    const s = { ...base, server: { ...base.server, host: "0.0.0.0" } };
    expect(() => LocalServer.validateConfig(s)).toThrow(ConfigError);
  });

  it("refuses a non-localhost host without a token even when opted in", () => {
    const s = { ...base, server: { ...base.server, host: "0.0.0.0", allowNonLocalhost: true, token: "" } };
    expect(() => LocalServer.validateConfig(s)).toThrow(/token is required/i);
  });

  it("allows a non-localhost host with opt-in AND a token", () => {
    const s = { ...base, server: { ...base.server, host: "0.0.0.0", allowNonLocalhost: true, token: "abc" } };
    expect(() => LocalServer.validateConfig(s)).not.toThrow();
  });
});

describe("LocalServer over a real socket", () => {
  it("starts, reports its address, and stops", async () => {
    const { server, addr } = await startServer();
    expect(server.isRunning()).toBe(true);
    expect(addr.port).toBeGreaterThan(0);
    await server.stop();
    expect(server.isRunning()).toBe(false);
    running = null;
  });

  it("handles an initialize handshake", async () => {
    const { addr } = await startServer();
    const res = await raw(addr.port, { body: RPC("initialize", { protocolVersion: "2025-06-18" }) });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.result.serverInfo.name).toBe("claude-code-engram");
  });

  it("executes a tools/call search over the index", async () => {
    const { addr } = await startServer({}, { "Notes/rag.md": "# RAG\nchunking markdown for retrieval." });
    const res = await raw(addr.port, {
      body: RPC("tools/call", { name: "search_vault_memory", arguments: { query: "chunking retrieval" } }),
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.result.isError).toBe(false);
    expect(json.result.content[0].text).toContain("Notes/rag.md");
  });

  it("returns 202 for a notification", async () => {
    const { addr } = await startServer();
    const res = await raw(addr.port, {
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
  });

  it("enforces token auth (401 without, 200 with)", async () => {
    const { addr } = await startServer({ token: "s3cret" });
    const noAuth = await raw(addr.port, { body: RPC("tools/list") });
    expect(noAuth.status).toBe(401);
    const withAuth = await raw(addr.port, {
      headers: { authorization: "Bearer s3cret" },
      body: RPC("tools/list"),
    });
    expect(withAuth.status).toBe(200);
  });

  it("rejects a foreign Host header (DNS-rebinding guard)", async () => {
    const { addr } = await startServer();
    const res = await raw(addr.port, { headers: { host: "evil.example.com" }, body: RPC("tools/list") });
    expect(res.status).toBe(403);
  });

  it("rejects a cross-origin browser request", async () => {
    const { addr } = await startServer();
    const res = await raw(addr.port, {
      headers: { origin: "https://evil.example.com" },
      body: RPC("tools/list"),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a non-JSON content type (415)", async () => {
    const { addr } = await startServer();
    const res = await raw(addr.port, { headers: { "content-type": "text/plain" }, body: "hi" });
    expect(res.status).toBe(415);
  });

  it("rejects non-POST methods (405)", async () => {
    const { addr } = await startServer();
    const res = await raw(addr.port, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("rejects an oversized body (413)", async () => {
    const { addr } = await startServer();
    const huge = "x".repeat(1_000_001);
    const res = await raw(addr.port, { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { huge } }) });
    expect(res.status).toBe(413);
  });

  it("returns a JSON-RPC parse error for malformed JSON (400)", async () => {
    const { addr } = await startServer();
    const res = await raw(addr.port, { body: "{not json" });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(-32700);
  });

  it("rejects an oversized JSON-RPC batch (400)", async () => {
    const { addr } = await startServer();
    const batch = JSON.stringify(
      Array.from({ length: 33 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" })),
    );
    const res = await raw(addr.port, { body: batch });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.message).toMatch(/batch too large/i);
  });

  it("returns 202 for a batch of only notifications", async () => {
    const { addr } = await startServer();
    const batch = JSON.stringify([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "ping" }, // notification (no id)
    ]);
    const res = await raw(addr.port, { body: batch });
    expect(res.status).toBe(202);
  });

  it("start() with an unchanged server config skips the rebind; a changed config restarts", async () => {
    // The settings tab commits per edit; a rebind kills in-flight MCP requests,
    // so an unchanged server config must be a no-op.
    const binds: string[] = [];
    const recordingLogger = {
      info: (msg: string) => {
        if (msg === "Starting local server") binds.push(msg);
      },
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => recordingLogger,
    } as unknown as typeof NULL_LOGGER;

    const adapter = new InMemoryVaultAdapter("v", {});
    const mk = (token: string, debugLogging = false): EngramSettings => ({
      ...DEFAULT_SETTINGS,
      debugLogging,
      server: { ...DEFAULT_SETTINGS.server, enabled: true, host: "127.0.0.1", port: 0, token },
    });
    const engine = new EngramEngine(adapter, mk("tok-a"), NULL_LOGGER);
    const server = new LocalServer({
      engine,
      logger: recordingLogger,
      serverInfo: { name: "claude-code-engram", version: "0.0.0" },
    });
    running = server;

    const addr1 = await server.start(mk("tok-a"));
    expect(binds.length).toBe(1);

    // Non-server settings change → same server config → no rebind, same port.
    const addr2 = await server.start(mk("tok-a", true));
    expect(binds.length).toBe(1);
    expect(addr2.port).toBe(addr1.port);

    // Server config change (new token) → real restart, and the NEW token is
    // the one that authenticates.
    const addr3 = await server.start(mk("tok-b"));
    expect(binds.length).toBe(2);
    const ok = await raw(addr3.port, { headers: { authorization: "Bearer tok-b" }, body: RPC("ping") });
    expect(ok.status).toBe(200);
    const stale = await raw(addr3.port, { headers: { authorization: "Bearer tok-a" }, body: RPC("ping") });
    expect(stale.status).toBe(401);
  });

  it("auth uses the settings committed at start(), never live host mutations", async () => {
    // The Obsidian settings tab mutates the ONE live settings object per
    // keystroke; a half-typed token must never reach auth before a commit
    // (i.e. before the host calls start() again).
    const live: EngramSettings = {
      ...DEFAULT_SETTINGS,
      server: { ...DEFAULT_SETTINGS.server, enabled: true, host: "127.0.0.1", port: 0, token: "committed-token" },
    };
    const adapter = new InMemoryVaultAdapter("v", {});
    const engine = new EngramEngine(adapter, live, NULL_LOGGER);
    const server = new LocalServer({
      engine,
      logger: NULL_LOGGER,
      serverInfo: { name: "claude-code-engram", version: "0.0.0" },
    });
    running = server;
    const addr = await server.start(live);

    live.server.token = "half-typ"; // keystroke — no commit yet
    const committed = await raw(addr.port, {
      headers: { authorization: "Bearer committed-token" },
      body: RPC("ping"),
    });
    expect(committed.status).toBe(200);
    const half = await raw(addr.port, { headers: { authorization: "Bearer half-typ" }, body: RPC("ping") });
    expect(half.status).toBe(401);
  });

  it("serializes overlapping restarts without leaking a listener", async () => {
    const { server, addr } = await startServer();
    const settings = {
      ...DEFAULT_SETTINGS,
      server: { ...DEFAULT_SETTINGS.server, enabled: true, host: "127.0.0.1", port: 0 },
    };
    // Fire several starts/stops concurrently; the single-flight chain must keep
    // exactly one server and never reject.
    await Promise.all([
      server.start(settings),
      server.stop(),
      server.start(settings),
      server.start(settings),
    ]);
    expect(server.isRunning()).toBe(true);
    // The final running server answers requests.
    const res = await raw(server.getAddress()!.port, { body: RPC("ping") });
    expect(res.status).toBe(200);
    void addr;
  });
});
