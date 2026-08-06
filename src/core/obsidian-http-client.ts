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
 */

import { requestUrl } from "obsidian";
import { HttpClient, HttpRequest, HttpResponse } from "./http-client";

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
    // degrade only catches REJECTIONS, never a never-resolving promise). Race the
    // request against a rejecting timer; the underlying request is abandoned (it
    // resolves into the void and is GC'd) and callers treat the rejection as
    // "provider unavailable" and fall back to lexical.
    const timeoutMs = req.timeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return send;

    let timer: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(
        () => reject(new Error(`HTTP request to ${hostOnly(req.url)} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([send, timeout]);
    } finally {
      if (timer) window.clearTimeout(timer);
    }
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
