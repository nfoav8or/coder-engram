import { describe, it, expect, vi } from "vitest";
import { FakeHttpClient } from "../src/core/http-client";
import {
  OllamaEmbeddingProvider,
  DEFAULT_OLLAMA_ENDPOINT,
} from "../src/embeddings/ollama-provider";
import { NULL_LOGGER } from "../src/utils/logger";

const ENDPOINT = "http://127.0.0.1:11434";

function make(http: FakeHttpClient, endpoint = ENDPOINT) {
  return new OllamaEmbeddingProvider({ http, endpoint, model: "nomic" });
}

describe("OllamaEmbeddingProvider", () => {
  it("has the expected id and default endpoint constant", () => {
    expect(DEFAULT_OLLAMA_ENDPOINT).toBe("http://127.0.0.1:11434");
    expect(make(new FakeHttpClient()).id).toBe("ollama");
  });

  it("POSTs to /api/embed with { model, input } and returns the matrix", async () => {
    const http = new FakeHttpClient();
    http.onExact("POST", `${ENDPOINT}/api/embed`, () => ({
      status: 200,
      body: JSON.stringify({ embeddings: [[1, 2, 3], [4, 5, 6]] }),
    }));
    const provider = make(http);
    const vectors = await provider.embed(["a", "b"]);
    expect(vectors).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(provider.dimensions).toBe(3);

    const call = http.calls[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${ENDPOINT}/api/embed`);
    expect(JSON.parse(call.body!)).toEqual({ model: "nomic", input: ["a", "b"] });
  });

  it("returns [] for empty input without any HTTP call", async () => {
    const http = new FakeHttpClient();
    const provider = make(http);
    expect(await provider.embed([])).toEqual([]);
    expect(http.calls.length).toBe(0);
  });

  it("throws on a non-2xx embed response", async () => {
    const http = new FakeHttpClient();
    http.onExact("POST", `${ENDPOINT}/api/embed`, () => ({ status: 500, body: "boom" }));
    await expect(make(http).embed(["a"])).rejects.toThrow(/HTTP 500/);
  });

  it("normalizes a trailing-slash endpoint (no double slash)", async () => {
    const http = new FakeHttpClient();
    http.on(() => true, () => ({ status: 200, body: JSON.stringify({ embeddings: [[1]] }) }));
    const provider = make(http, "http://x:11434/");
    await provider.embed(["a"]);
    expect(http.calls[0].url).toBe("http://x:11434/api/embed");
  });

  it("isAvailable GETs /api/tags and is true on 2xx", async () => {
    const http = new FakeHttpClient();
    http.onExact("GET", `${ENDPOINT}/api/tags`, () => ({ status: 200, body: "{}" }));
    expect(await make(http).isAvailable()).toBe(true);
  });

  it("isAvailable is false on a non-2xx tags response", async () => {
    const http = new FakeHttpClient();
    http.onExact("GET", `${ENDPOINT}/api/tags`, () => ({ status: 404, body: "" }));
    expect(await make(http).isAvailable()).toBe(false);
  });

  it("logs the status on a non-2xx tags response, distinct from a transport failure", async () => {
    // A reachable-but-rejecting endpoint (bad auth, wrong path) previously
    // logged nothing at all — indistinguishable from "not started yet."
    const http = new FakeHttpClient();
    http.onExact("GET", `${ENDPOINT}/api/tags`, () => ({ status: 401, body: "" }));
    const warn = vi.fn();
    const provider = new OllamaEmbeddingProvider({
      http,
      endpoint: ENDPOINT,
      model: "nomic",
      logger: { ...NULL_LOGGER, warn },
    });
    expect(await provider.isAvailable()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not usable"), { status: 401 });
  });

  it("isAvailable is false on a transport error", async () => {
    const http = new FakeHttpClient();
    http.on(() => true, () => Promise.reject(new Error("ECONNREFUSED")));
    expect(await make(http).isAvailable()).toBe(false);
  });
});
