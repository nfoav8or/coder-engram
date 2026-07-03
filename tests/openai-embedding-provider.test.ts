import { describe, it, expect } from "vitest";
import { FakeHttpClient } from "../src/core/http-client";
import { OpenAiEmbeddingProvider } from "../src/embeddings/openai-embedding-provider";

const ENDPOINT = "https://api.example.com/v1";
const KEY = "sk-test-123";

function make(http: FakeHttpClient, endpoint = ENDPOINT, apiKey = KEY) {
  return new OpenAiEmbeddingProvider({ http, endpoint, model: "text-embed", apiKey });
}

describe("OpenAiEmbeddingProvider", () => {
  it("has the expected id", () => {
    expect(make(new FakeHttpClient()).id).toBe("openai-compatible");
  });

  it("POSTs to /embeddings with auth + content-type headers and { model, input }", async () => {
    const http = new FakeHttpClient();
    http.onExact("POST", `${ENDPOINT}/embeddings`, () => ({
      status: 200,
      body: JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }),
    }));
    const provider = make(http);
    const out = await provider.embed(["hello"]);
    expect(out).toEqual([[1, 2]]);
    expect(provider.dimensions).toBe(2);

    const call = http.calls[0];
    expect(call.url).toBe(`${ENDPOINT}/embeddings`);
    expect(call.headers?.["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(call.headers?.["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call.body!)).toEqual({ model: "text-embed", input: ["hello"] });
  });

  it("reorders out-of-order data by index so output matches input order", async () => {
    const http = new FakeHttpClient();
    // Data returned in REVERSED index order.
    http.onExact("POST", `${ENDPOINT}/embeddings`, () => ({
      status: 200,
      body: JSON.stringify({
        data: [
          { index: 2, embedding: [3, 3] },
          { index: 0, embedding: [1, 1] },
          { index: 1, embedding: [2, 2] },
        ],
      }),
    }));
    const out = await make(http).embed(["a", "b", "c"]);
    expect(out).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it("throws on a non-2xx response", async () => {
    const http = new FakeHttpClient();
    http.onExact("POST", `${ENDPOINT}/embeddings`, () => ({ status: 401, body: "nope" }));
    await expect(make(http).embed(["a"])).rejects.toThrow(/HTTP 401/);
  });

  it("throws when data is not an array", async () => {
    const http = new FakeHttpClient();
    http.onExact("POST", `${ENDPOINT}/embeddings`, () => ({
      status: 200,
      body: JSON.stringify({ data: { nope: true } }),
    }));
    await expect(make(http).embed(["a"])).rejects.toThrow(/no data array/i);
  });

  it("returns [] for empty input without any HTTP call", async () => {
    const http = new FakeHttpClient();
    expect(await make(http).embed([])).toEqual([]);
    expect(http.calls.length).toBe(0);
  });

  it("isAvailable returns false with an empty endpoint and makes no request", async () => {
    const http = new FakeHttpClient();
    expect(await make(http, "", KEY).isAvailable()).toBe(false);
    expect(http.calls.length).toBe(0);
  });

  it("isAvailable returns false with an empty apiKey and makes no request", async () => {
    const http = new FakeHttpClient();
    expect(await make(http, ENDPOINT, "").isAvailable()).toBe(false);
    expect(http.calls.length).toBe(0);
  });

  it("isAvailable GETs /models with auth and is true on 2xx", async () => {
    const http = new FakeHttpClient();
    http.onExact("GET", `${ENDPOINT}/models`, () => ({ status: 200, body: "{}" }));
    expect(await make(http).isAvailable()).toBe(true);
    expect(http.calls[0].headers?.["Authorization"]).toBe(`Bearer ${KEY}`);
  });

  it("isAvailable is false on a non-2xx /models response", async () => {
    const http = new FakeHttpClient();
    http.onExact("GET", `${ENDPOINT}/models`, () => ({ status: 500, body: "" }));
    expect(await make(http).isAvailable()).toBe(false);
  });
});
