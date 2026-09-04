/**
 * A trimmed string, or "" for anything that is not one.
 *
 * Optional chaining guards `null` and `undefined` but not the wrong TYPE, so
 * `config.endpoint?.trim()` threw a TypeError on a number or an object —
 * from the one function in this file documented as never throwing. It is not
 * reachable through the plugin today, because `migrateSettings` coerces these
 * fields first, but the point of a never-throws boundary is that a caller does
 * not have to know that.
 */
function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * createEmbeddingProvider — build the configured EmbeddingProvider, or null.
 *
 * Returning null is the graceful-degrade signal: the engine falls back to
 * lexical retrieval. We return null (never throw) whenever required config is
 * missing so a half-configured provider can never break search — honesty over a
 * broken vector path.
 */

import { HttpClient } from "../core/http-client";
import { Logger, NULL_LOGGER } from "../utils/logger";
import { EmbeddingProvider } from "./embedding-provider";
import { MockEmbeddingProvider } from "./mock-embedding-provider";
import { OllamaEmbeddingProvider, DEFAULT_OLLAMA_ENDPOINT } from "./ollama-provider";
import { OpenAiEmbeddingProvider } from "./openai-embedding-provider";

export interface EmbeddingConfig {
  provider: "none" | "mock" | "ollama" | "openai-compatible";
  model: string;
  endpoint: string;
  apiKey: string;
}

export interface ProviderDeps {
  http?: HttpClient;
  logger?: Logger;
}

export function createEmbeddingProvider(
  config: EmbeddingConfig,
  deps: ProviderDeps = {},
): EmbeddingProvider | null {
  const logger = deps.logger ?? NULL_LOGGER;
  switch (config.provider) {
    case "none":
      return null;

    case "mock":
      return new MockEmbeddingProvider();

    case "ollama": {
      const model = asTrimmed(config.model);
      if (!model) {
        logger.warn("Ollama provider needs a model name; using lexical retrieval");
        return null;
      }
      if (!deps.http) {
        logger.warn("No HTTP client available for Ollama; using lexical retrieval");
        return null;
      }
      return new OllamaEmbeddingProvider({
        http: deps.http,
        endpoint: asTrimmed(config.endpoint) || DEFAULT_OLLAMA_ENDPOINT,
        model,
        logger,
      });
    }

    case "openai-compatible": {
      const model = asTrimmed(config.model);
      const endpoint = asTrimmed(config.endpoint);
      const apiKey = asTrimmed(config.apiKey);
      if (!model || !endpoint || !apiKey) {
        logger.warn(
          "OpenAI-compatible provider needs endpoint, model, and API key; using lexical retrieval",
        );
        return null;
      }
      if (!deps.http) {
        logger.warn("No HTTP client available for OpenAI-compatible; using lexical retrieval");
        return null;
      }
      return new OpenAiEmbeddingProvider({
        http: deps.http,
        endpoint,
        model,
        apiKey,
        logger,
      });
    }

    default:
      return null;
  }
}
