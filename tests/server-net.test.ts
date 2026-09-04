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
  it("allows any loopback spelling in Host when the bound host is loopback", () => {
    expect(isHostHeaderAllowed("127.0.0.1:3999", "127.0.0.1")).toBe(true);
    expect(isHostHeaderAllowed("localhost:3999", "127.0.0.1")).toBe(true);
    expect(isHostHeaderAllowed("[::1]:3999", "localhost")).toBe(true);
  });
  it("does NOT let a loopback Host reach a non-loopback bind", () => {
    // The old expectation here read "regardless of bound host", and it was only
    // ever exercised with a loopback bind — the pairing that diverges from the
    // documented model (a non-loopback bind under allowNonLocalhost, with a
    // loopback-shaped Host) had no test, so the guard silently passed it.
    expect(isHostHeaderAllowed("localhost:3999", "192.168.1.5")).toBe(false);
    expect(isHostHeaderAllowed("127.0.0.1:3999", "192.168.1.5")).toBe(false);
    expect(isHostHeaderAllowed("[::1]:3999", "192.168.1.5")).toBe(false);
  });
  it("allows a Host that matches the bound (non-loopback) host", () => {
    expect(isHostHeaderAllowed("192.168.1.5:3999", "192.168.1.5")).toBe(true);
  });
  it("rejects a foreign Host header (DNS-rebinding attempt)", () => {
    expect(isHostHeaderAllowed("evil.example.com", "127.0.0.1")).toBe(false);
    expect(isHostHeaderAllowed(undefined, "127.0.0.1")).toBe(false);
  });
});

describe("isHostHeaderAllowed empty-name handling", () => {
  it("never treats an empty hostname as agreeing with an empty bound host", () => {
    // `Host: :1234` is all port, so the hostname parses as ""; a whitespace-only
    // configured host trims to an empty bound host. Comparing the two for
    // equality made the rebinding guard pass anything shaped that way. A guard
    // has to fail closed on a degenerate input, not read it as a match.
    expect(isHostHeaderAllowed(":1234", "")).toBe(false);
    expect(isHostHeaderAllowed("", "")).toBe(false);
    expect(isHostHeaderAllowed("::1", "")).toBe(false);
    // A real bound host still matches, case-insensitively, and a foreign name
    // is still rejected.
    expect(isHostHeaderAllowed("Engram.local", "engram.local")).toBe(true);
    expect(isHostHeaderAllowed("evil.com", "engram.local")).toBe(false);
  });

  it("normalizes an Origin the way a browser does before checking it", () => {
    // `new URL` applies IDNA mapping, so these reduce to a real hostname rather
    // than being compared as raw text: U+2460 maps to "1" and U+3002 to ".".
    // Both directions matter — the first two ARE loopback and must pass, the
    // rest only look like it and must not.
    expect(isOriginAllowed("http://\u246027.0.0.1")).toBe(true);
    expect(isOriginAllowed("http://0x7f.0.0.1")).toBe(true);
    expect(isOriginAllowed("http://127.0.0.1\u3002evil.com")).toBe(false);
    expect(isOriginAllowed("http://localhost\u3002evil.com")).toBe(false);
    expect(isOriginAllowed("http://127.0.0.1%2eevil.com")).toBe(false);
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
