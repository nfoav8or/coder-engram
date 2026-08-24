/**
 * OpenAiEmbeddingProvider — embeddings via any OpenAI-compatible `/embeddings`
 * endpoint (OpenAI, LM Studio, LocalAI, vLLM, etc.).
 *
 * `POST {endpoint}/embeddings` with `{ model, input: string[] }` and an
 * `Authorization: Bearer <apiKey>` header. The response `data[]` carries an
 * `index` per row; we sort by it before extracting vectors so output order
 * matches input order regardless of server ordering.
 *
 * SECURITY: this sends indexed chunk text to a potentially REMOTE service and
 * carries a secret API key. The key is passed only in the Authorization header
 * and is never logged. Selecting this provider is an explicit, opt-in choice.
 */

import { HttpClient } from "../core/http-client";
import { toMessage } from "../utils/errors";
import { Logger, NULL_LOGGER } from "../utils/logger";
import { EmbeddingProvider } from "./embedding-provider";
import { normalizeEndpoint, parseVectorMatrix } from "./embedding-http";

export interface OpenAiProviderOptions {
  http: HttpClient;
  /** Base URL including any version prefix, e.g. "https://api.openai.com/v1". */
  endpoint: string;
  model: string;
  apiKey: string;
  logger?: Logger;
  timeoutMs?: number;
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai-compatible";
  readonly model: string;
  private readonly http: HttpClient;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private dim = 0;

  constructor(opts: OpenAiProviderOptions) {
    this.http = opts.http;
    this.endpoint = normalizeEndpoint(opts.endpoint);
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.logger = opts.logger ?? NULL_LOGGER;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  get dimensions(): number {
    return this.dim;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    return headers;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.http.request({
      url: `${this.endpoint}/embeddings`,
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ model: this.model, input: texts }),
      timeoutMs: this.timeoutMs,
    });
    if (res.status < 200 || res.status >= 300) {
      // Do NOT include the response body: some servers echo request context.
      throw new Error(`OpenAI-compatible embed failed (HTTP ${res.status})`);
    }
    const parsed = JSON.parse(res.body) as { data?: Array<{ index?: number; embedding?: unknown }> };
    if (!Array.isArray(parsed.data)) {
      throw new Error("OpenAI-compatible: response had no data array");
    }
    // Sort by `index` so output order matches input order.
    const rows = [...parsed.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    // If the server supplies indices, they must be a proper permutation of
    // 0..n-1 — otherwise a duplicated/missing index would silently misattribute
    // a vector to the wrong chunk. (Servers that omit `index` keep response
    // order, which we already preserve.)
    const hasIndices = rows.some((r) => r.index !== undefined);
    if (hasIndices) {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].index !== i) {
          throw new Error("OpenAI-compatible: response indices were not a 0..n-1 permutation");
        }
      }
    }
    const matrix = parseVectorMatrix(
      rows.map((r) => r.embedding),
      texts.length,
      "OpenAI-compatible",
    );
    if (matrix.length > 0) this.dim = matrix[0].length;
    return matrix;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.endpoint || !this.apiKey) return false;
    try {
      const res = await this.http.request({
        url: `${this.endpoint}/models`,
        method: "GET",
        headers: this.authHeaders(),
        timeoutMs: 5_000,
      });
      const ok = res.status >= 200 && res.status < 300;
      if (!ok) {
        // Distinguishes "not started yet" (network failure, caught below)
        // from "reachable but rejecting requests" (bad key, wrong model,
        // auth failure) — a 401 here previously logged nothing at all, so a
        // persistently wrong key degraded to lexical with no signal beyond a
        // one-time settings-save Notice easy to miss.
        this.logger.warn("OpenAI-compatible endpoint responded but is not usable", { status: res.status });
      }
      return ok;
    } catch (err) {
      this.logger.warn("OpenAI-compatible endpoint not reachable", {
        error: toMessage(err),
      });
      return false;
    }
  }
}
