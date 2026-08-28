/**
 * server/net — small, pure host/origin helpers shared by the server shell.
 *
 * Kept separate from local-server.ts (which owns sockets) so the DNS-rebinding
 * and loopback-binding guards can be unit-tested without opening a port.
 */

/** True if `host` is a loopback address we consider safe to bind without opt-in. */
export function isLoopbackHost(host: string): boolean {
  const h = stripBrackets(host.trim().toLowerCase());
  if (h === "localhost" || h === "::1" || h === "0000:0000:0000:0000:0000:0000:0000:0001") {
    return true;
  }
  // Any 127.0.0.0/8 address is loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Extract the hostname from a `Host:` header value (handles host:port and [::1]:port). */
export function hostnameFromHostHeader(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (v === "") return null;
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    return end > 0 ? v.slice(1, end) : null;
  }
  // host or host:port. A bracket-less value is treated as `hostname[:port]`, so
  // the hostname is everything before the first colon. (Bare IPv6 like `::1` is
  // malformed in a Host header without brackets and will fail the allow-check.)
  const colon = v.indexOf(":");
  return colon === -1 ? v : v.slice(0, colon);
}

/**
 * Validate the Host header against the address we are actually bound to.
 * Prevents DNS-rebinding: a browser resolving an attacker domain to 127.0.0.1
 * would send that domain in Host, which will not match.
 */
export function isHostHeaderAllowed(hostHeader: string | undefined, boundHost: string): boolean {
  const name = hostnameFromHostHeader(hostHeader);
  if (name === null) return false;
  const lower = name.toLowerCase();
  if (isLoopbackHost(lower)) return true;
  const bound = stripBrackets(boundHost.trim().toLowerCase());
  // Neither side may be empty. `Host: :1234` yields an empty hostname (the
  // header is all port), and a whitespace-only configured host trims to an
  // empty bound host — so without this the two compared equal and the
  // rebinding guard passed anything shaped that way. Comparing empty to empty
  // is never a real match, and a guard has to fail closed on a degenerate
  // input rather than treat it as agreement.
  if (lower === "" || bound === "") return false;
  return lower === bound;
}

/**
 * If an Origin header is present it must be a loopback origin. Non-browser
 * clients (e.g. Claude Code) send NO Origin header and pass trivially. A browser
 * request always carries one: a malicious page's Origin is not loopback, and an
 * opaque origin (sandboxed iframe, data:/blob:) sends the literal `null` — both
 * are rejected. Only a genuinely absent header is allowed through.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return isLoopbackHost(url.hostname);
  } catch {
    // Includes the opaque-origin sentinel "null" and any malformed value.
    return false;
  }
}

function stripBrackets(h: string): string {
  return h.replace(/^\[/, "").replace(/\]$/, "");
}
