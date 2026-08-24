/**
 * OllamaEmbeddingProvider — embeddings via a local Ollama server.
 *
 * Uses the batch `POST {endpoint}/api/embed` API: `{ model, input: string[] }`
 * -> `{ embeddings: number[][] }`. Dimensionality is not known until the first
 * response, so `dimensions` is 0 until then and reported from the vectors.
 *
 * Runs against a user-configured endpoint (default localhost); no API key. All
 * networking goes through the injected HttpClient, so this class is pure and
 * unit-testable.
 */

import { HttpClient } from "../core/http-client";
import { toMessage } from "../utils/errors";
import { Logger, NULL_LOGGER } from "../utils/logger";
import { EmbeddingProvider } from "./embedding-provider";
import { normalizeEndpoint, parseVectorMatrix } from "./embedding-http";

export interface OllamaProviderOptions {
  http: HttpClient;
  /** Base URL, e.g. "http://127.0.0.1:11434". */
  endpoint: string;
  model: string;
  logger?: Logger;
  timeoutMs?: number;
}

export const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = "ollama";
  readonly model: string;
  private readonly http: HttpClient;
  private readonly endpoint: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private dim = 0;

  constructor(opts: OllamaProviderOptions) {
    this.http = opts.http;
    this.endpoint = normalizeEndpoint(opts.endpoint || DEFAULT_OLLAMA_ENDPOINT);
    this.model = opts.model;
    this.logger = opts.logger ?? NULL_LOGGER;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  get dimensions(): number {
    return this.dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.http.request({
      url: `${this.endpoint}/api/embed`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
      timeoutMs: this.timeoutMs,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Ollama embed failed (HTTP ${res.status})`);
    }
    const parsed = JSON.parse(res.body) as unknown;
    const vectors = parseVectorMatrix(
      (parsed as { embeddings?: unknown })?.embeddings,
      texts.length,
      "Ollama",
    );
    if (vectors.length > 0) this.dim = vectors[0].length;
    return vectors;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.http.request({
        url: `${this.endpoint}/api/tags`,
        method: "GET",
        timeoutMs: 5_000,
      });
      const ok = res.status >= 200 && res.status < 300;
      if (!ok) {
        this.logger.warn("Ollama responded but is not usable", { status: res.status });
      }
      return ok;
    } catch (err) {
      this.logger.warn("Ollama not reachable", {
        error: toMessage(err),
      });
      return false;
    }
  }
}
