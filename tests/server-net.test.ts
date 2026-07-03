import { describe, it, expect } from "vitest";
import {
  isLoopbackHost,
  hostnameFromHostHeader,
  isHostHeaderAllowed,
  isOriginAllowed,
} from "../src/server/net";

describe("isLoopbackHost", () => {
  it("recognizes loopback addresses", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.5.6.7")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
  });
  it("rejects non-loopback addresses", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
  });
});

describe("hostnameFromHostHeader", () => {
  it("extracts hostnames from host[:port] and [ipv6]:port", () => {
    expect(hostnameFromHostHeader("127.0.0.1:3999")).toBe("127.0.0.1");
    expect(hostnameFromHostHeader("localhost")).toBe("localhost");
    expect(hostnameFromHostHeader("[::1]:3999")).toBe("::1");
    expect(hostnameFromHostHeader(undefined)).toBeNull();
    expect(hostnameFromHostHeader("")).toBeNull();
  });
});

describe("isHostHeaderAllowed", () => {
  it("allows loopback Host headers regardless of bound host", () => {
    expect(isHostHeaderAllowed("127.0.0.1:3999", "127.0.0.1")).toBe(true);
    expect(isHostHeaderAllowed("localhost:3999", "127.0.0.1")).toBe(true);
  });
  it("allows a Host that matches the bound (non-loopback) host", () => {
    expect(isHostHeaderAllowed("192.168.1.5:3999", "192.168.1.5")).toBe(true);
  });
  it("rejects a foreign Host header (DNS-rebinding attempt)", () => {
    expect(isHostHeaderAllowed("evil.example.com", "127.0.0.1")).toBe(false);
    expect(isHostHeaderAllowed(undefined, "127.0.0.1")).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  it("allows only a genuinely absent Origin (non-browser clients send none)", () => {
    expect(isOriginAllowed(undefined)).toBe(true);
  });
  it("rejects opaque origins (empty string and the literal 'null')", () => {
    // Sandboxed iframes / data: / blob: contexts send Origin: null.
    expect(isOriginAllowed("")).toBe(false);
    expect(isOriginAllowed("null")).toBe(false);
  });
  it("allows loopback origins", () => {
    expect(isOriginAllowed("http://127.0.0.1:3999")).toBe(true);
    expect(isOriginAllowed("http://localhost")).toBe(true);
  });
  it("rejects foreign browser origins", () => {
    expect(isOriginAllowed("https://evil.example.com")).toBe(false);
    expect(isOriginAllowed("not-a-url")).toBe(false);
  });
});
