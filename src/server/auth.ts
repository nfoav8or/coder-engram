/**
 * server/auth — token authentication for the local server.
 *
 * SECURITY:
 *   - Compares tokens in constant time (sha256 digest + timingSafeEqual) so an
 *     attacker cannot recover the token byte-by-byte from response timing.
 *   - Never logs or echoes the token. Callers surface only a boolean/decision.
 *   - When no token is configured, auth is "open" ONLY for loopback binds; the
 *     server layer refuses to start a token-less server on a non-loopback host.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality. Both inputs are hashed to a fixed-width
 * digest first, so the comparison time does not depend on the inputs' lengths
 * or on where they first differ.
 */
export function timingSafeStrEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  // Digests are always 32 bytes, so timingSafeEqual never throws on length.
  return timingSafeEqual(da, db);
}

/**
 * Extract a bearer token from an Authorization header value.
 * Accepts "Bearer <token>" (case-insensitive scheme). Returns null if absent
 * or malformed. A raw header array (Node lowercases keys but may give arrays)
 * is reduced to its first value.
 */
export function extractBearerToken(headerValue: string | string[] | undefined): string | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw !== "string") return null;
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(raw);
  return match ? match[1] : null;
}

export type AuthDecision =
  | { ok: true; reason: "no-token-required" | "valid-token" }
  | { ok: false; reason: "missing-token" | "invalid-token" };

/**
 * Decide whether a request is authorized.
 *
 * @param configuredToken the token from settings (empty string = none set)
 * @param headerValue     the incoming Authorization header value
 *
 * When a token is configured it is REQUIRED and must match exactly. When no
 * token is configured, the request is allowed (the server layer only permits
 * token-less operation on loopback binds).
 */
export function checkAuth(
  configuredToken: string,
  headerValue: string | string[] | undefined,
): AuthDecision {
  const expected = configuredToken.trim();
  if (expected === "") {
    return { ok: true, reason: "no-token-required" };
  }
  const provided = extractBearerToken(headerValue);
  if (provided === null) {
    return { ok: false, reason: "missing-token" };
  }
  return timingSafeStrEqual(provided, expected)
    ? { ok: true, reason: "valid-token" }
    : { ok: false, reason: "invalid-token" };
}
