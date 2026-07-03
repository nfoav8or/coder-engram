import { describe, it, expect } from "vitest";
import { FakeHttpClient, HttpRequest } from "../src/core/http-client";

describe("FakeHttpClient", () => {
  it("routes by predicate and records calls", async () => {
    const http = new FakeHttpClient();
    http.on(
      (r) => r.url.endsWith("/ping"),
      () => ({ status: 200, body: "pong" }),
    );
    const res = await http.request({ url: "http://x/ping", method: "GET" });
    expect(res).toEqual({ status: 200, body: "pong" });
    expect(http.calls.length).toBe(1);
    expect(http.calls[0].url).toBe("http://x/ping");
  });

  it("onExact matches method + url exactly", async () => {
    const http = new FakeHttpClient();
    http.onExact("POST", "http://x/a", () => ({ status: 201, body: "created" }));
    const res = await http.request({ url: "http://x/a", method: "POST" });
    expect(res.status).toBe(201);
  });

  it("onExact does not match a different method", async () => {
    const http = new FakeHttpClient();
    http.onExact("POST", "http://x/a", () => ({ status: 201, body: "" }));
    await expect(http.request({ url: "http://x/a", method: "GET" })).rejects.toThrow();
  });

  it("first matching route wins", async () => {
    const http = new FakeHttpClient();
    http.on(() => true, () => ({ status: 111, body: "first" }));
    http.on(() => true, () => ({ status: 222, body: "second" }));
    const res = await http.request({ url: "http://x", method: "GET" });
    expect(res.status).toBe(111);
  });

  it("supports async responders", async () => {
    const http = new FakeHttpClient();
    http.on(() => true, async () => ({ status: 200, body: "async" }));
    const res = await http.request({ url: "http://x", method: "GET" });
    expect(res.body).toBe("async");
  });

  it("throws when no route matches", async () => {
    const http = new FakeHttpClient();
    await expect(http.request({ url: "http://x", method: "GET" })).rejects.toThrow(
      /no route/i,
    );
  });

  it("records every call including unmatched attempts", async () => {
    const http = new FakeHttpClient();
    const req: HttpRequest = { url: "http://x", method: "GET" };
    await expect(http.request(req)).rejects.toThrow();
    expect(http.calls.length).toBe(1);
    expect(http.calls[0]).toBe(req);
  });
});
