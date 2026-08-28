/**
 * ObsidianHttpClient — production HttpClient backed by Obsidian's `requestUrl`.
 *
 * `requestUrl` performs the request from the Electron main process, so it is not
 * subject to browser CORS and works against localhost (Ollama) and remote
 * (OpenAI-compatible) endpoints alike. Alongside ObsidianVaultAdapter, this is
 * one of only two service files permitted to import `obsidian`.
 *
 * We pass `throw: false` so non-2xx responses come back as values (the caller
 * branches on status); transport failures still reject, which callers treat as
 * "provider unavailable".
 *
 * TESTING: `requestUrl` is an Obsidian VALUE import, and the `obsidian` package
 * ships types only — there is no runtime binding for it outside the Electron
 * host, so this file cannot be loaded by the Node test suite at all. The
 * timeout semantics it relies on are unit-tested where they live, in
 * `utils/timeout.ts` (`tests/timeout.test.ts`); everything below that is
 * covered only by the Playwright e2e harness in `tests/e2e/`.
 */

import { requestUrl } from "obsidian";
import { HttpClient, HttpRequest, HttpResponse } from "./http-client";
import { withTimeout } from "../utils/timeout";

export class ObsidianHttpClient implements HttpClient {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const send = requestUrl({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body,
      throw: false,
    }).then((res) => {
      // `res.text` is a getter that decodes the body; guard against undefined.
      let body = "";
      try {
        body = res.text ?? "";
      } catch {
        body = "";
      }
      return { status: res.status, body };
    });

    // `requestUrl` cannot be aborted and has no timeout of its own, so a stalled
    // endpoint would otherwise hang search/indexing forever (the callers' graceful
    // degrade only catches REJECTIONS, never a never-resolving promise). The
    // request is bounded by the shared `withTimeout` guard — which exists
    // precisely so this pattern is not written out per call site — and the
    // underlying request is abandoned (it resolves into the void and is GC'd);
    // callers treat the rejection as "provider unavailable" and fall back to
    // lexical. The label is host-only: a timeout message must never carry the
    // path or query, which can hold sensitive material.
    const timeoutMs = req.timeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return send;
    return withTimeout(send, timeoutMs, hostOnly(req.url));
  }
}

/** Host (and port) of a URL for error messages — never the path/query, which
 * could carry sensitive material. Falls back to a constant on parse failure. */
function hostOnly(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "endpoint";
  }
}
