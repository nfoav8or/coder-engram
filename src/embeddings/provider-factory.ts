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
      const model = config.model?.trim();
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
        endpoint: config.endpoint?.trim() || DEFAULT_OLLAMA_ENDPOINT,
        model,
        logger,
      });
    }

    case "openai-compatible": {
      const model = config.model?.trim();
      const endpoint = config.endpoint?.trim();
      const apiKey = config.apiKey?.trim();
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
