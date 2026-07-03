/**
 * HttpClient — the boundary for OUTBOUND HTTP (embedding providers).
 *
 * Mirrors the VaultAdapter pattern: embedding providers depend only on this
 * interface, so they stay Obsidian-free and unit-testable with a fake. The one
 * production implementation (ObsidianHttpClient) wraps Obsidian's `requestUrl`,
 * which avoids CORS and works in the Electron renderer. This is the ONLY
 * networking the plugin performs as a client — the local server (M2) is an
 * inbound listener and is unrelated.
 *
 * Security note: providers send already-indexed chunk text to a user-configured
 * endpoint. That is an explicit opt-in (the default provider is "none"). Nothing
 * here logs headers or bodies; auth headers carry secrets and must never be
 * logged by callers.
 */

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  /** Request body (already serialized, e.g. JSON.stringify(...)). */
  body?: string;
  /** Abort budget in ms. Implementations SHOULD enforce this. */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** Raw response text. Callers parse JSON themselves. */
  body: string;
}

export interface HttpClient {
  /**
   * Perform an HTTP request. Implementations MUST resolve with the response for
   * any HTTP status (including 4xx/5xx) rather than throwing — callers branch on
   * `status`. They may reject only for transport failures (DNS, connection
   * refused, timeout), which callers treat as "provider unavailable".
   */
  request(req: HttpRequest): Promise<HttpResponse>;
}

/**
 * In-memory HttpClient for tests. Routes by `${method} ${url}` (exact) or by a
 * predicate handler. Records calls for assertions. Never touches the network.
 */
export class FakeHttpClient implements HttpClient {
  readonly calls: HttpRequest[] = [];
  private routes: Array<{
    match: (req: HttpRequest) => boolean;
    respond: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;
  }> = [];

  /** Register a handler for requests matching a predicate (first match wins). */
  on(
    match: (req: HttpRequest) => boolean,
    respond: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
  ): this {
    this.routes.push({ match, respond });
    return this;
  }

  /** Convenience: match an exact `${method} ${url}`. */
  onExact(
    method: HttpRequest["method"],
    url: string,
    respond: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
  ): this {
    return this.on((r) => r.method === method && r.url === url, respond);
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    for (const route of this.routes) {
      if (route.match(req)) return route.respond(req);
    }
    throw new Error(`FakeHttpClient: no route for ${req.method} ${req.url}`);
  }
}
