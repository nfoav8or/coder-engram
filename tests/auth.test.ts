import { describe, it, expect } from "vitest";
import { timingSafeStrEqual, extractBearerToken, checkAuth } from "../src/server/auth";

describe("timingSafeStrEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeStrEqual("s3cret-token", "s3cret-token")).toBe(true);
  });
  it("returns false for different strings, including differing lengths", () => {
    expect(timingSafeStrEqual("abc", "abd")).toBe(false);
    expect(timingSafeStrEqual("short", "a-much-longer-token")).toBe(false);
    expect(timingSafeStrEqual("", "x")).toBe(false);
  });
  it("treats empty vs empty as equal", () => {
    expect(timingSafeStrEqual("", "")).toBe(true);
  });
});

describe("extractBearerToken", () => {
  it("parses a well-formed Bearer header (case-insensitive scheme)", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    expect(extractBearerToken("bearer abc123")).toBe("abc123");
    expect(extractBearerToken("  Bearer   abc123  ")).toBe("abc123");
  });
  it("reduces an array header to its first value", () => {
    expect(extractBearerToken(["Bearer abc", "Bearer def"])).toBe("abc");
  });
  it("returns null for missing or malformed headers", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("abc123")).toBeNull();
    expect(extractBearerToken("Bearer ")).toBeNull();
  });
});

describe("checkAuth", () => {
  it("allows any request when no token is configured", () => {
    expect(checkAuth("", undefined)).toEqual({ ok: true, reason: "no-token-required" });
    expect(checkAuth("   ", "Bearer whatever")).toEqual({ ok: true, reason: "no-token-required" });
  });
  it("accepts a matching token", () => {
    expect(checkAuth("t0ken", "Bearer t0ken")).toEqual({ ok: true, reason: "valid-token" });
  });
  it("rejects a missing token when one is required", () => {
    expect(checkAuth("t0ken", undefined)).toEqual({ ok: false, reason: "missing-token" });
    expect(checkAuth("t0ken", "Basic t0ken")).toEqual({ ok: false, reason: "missing-token" });
  });
  it("rejects a wrong token", () => {
    expect(checkAuth("t0ken", "Bearer nope")).toEqual({ ok: false, reason: "invalid-token" });
  });
});
