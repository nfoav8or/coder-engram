import { describe, it, expect } from "vitest";
import { createEmbeddingProvider, EmbeddingConfig } from "../src/embeddings/provider-factory";
import { FakeHttpClient } from "../src/core/http-client";
import { MockEmbeddingProvider } from "../src/embeddings/mock-embedding-provider";
import { OllamaEmbeddingProvider } from "../src/embeddings/ollama-provider";
import { OpenAiEmbeddingProvider } from "../src/embeddings/openai-embedding-provider";

function cfg(partial: Partial<EmbeddingConfig>): EmbeddingConfig {
  return { provider: "none", model: "", endpoint: "", apiKey: "", ...partial };
}

describe("createEmbeddingProvider", () => {
  it("returns null for none", () => {
    expect(createEmbeddingProvider(cfg({ provider: "none" }))).toBeNull();
  });

  it("returns a MockEmbeddingProvider for mock (no http needed)", () => {
    const p = createEmbeddingProvider(cfg({ provider: "mock" }));
    expect(p).toBeInstanceOf(MockEmbeddingProvider);
    expect(p?.id).toBe("mock");
  });

  describe("ollama", () => {
    it("returns null when model is missing", () => {
      const p = createEmbeddingProvider(cfg({ provider: "ollama", model: "" }), {
        http: new FakeHttpClient(),
      });
      expect(p).toBeNull();
    });
    it("returns null when http is missing", () => {
      const p = createEmbeddingProvider(cfg({ provider: "ollama", model: "nomic" }));
      expect(p).toBeNull();
    });
    it("builds an OllamaEmbeddingProvider when model + http present", () => {
      const p = createEmbeddingProvider(cfg({ provider: "ollama", model: "nomic" }), {
        http: new FakeHttpClient(),
      });
      expect(p).toBeInstanceOf(OllamaEmbeddingProvider);
      expect(p?.id).toBe("ollama");
    });
    it("returns null when model is whitespace-only (a hand-edited data.json, not the settings UI)", () => {
      const p = createEmbeddingProvider(cfg({ provider: "ollama", model: "   " }), {
        http: new FakeHttpClient(),
      });
      expect(p).toBeNull();
    });
  });

  describe("openai-compatible", () => {
    const full = { provider: "openai-compatible" as const, model: "m", endpoint: "http://x", apiKey: "k" };
    it("returns null when endpoint missing", () => {
      expect(
        createEmbeddingProvider(cfg({ ...full, endpoint: "" }), { http: new FakeHttpClient() }),
      ).toBeNull();
    });
    it("returns null when model missing", () => {
      expect(
        createEmbeddingProvider(cfg({ ...full, model: "" }), { http: new FakeHttpClient() }),
      ).toBeNull();
    });
    it("returns null when apiKey missing", () => {
      expect(
        createEmbeddingProvider(cfg({ ...full, apiKey: "" }), { http: new FakeHttpClient() }),
      ).toBeNull();
    });
    it("returns null when http missing", () => {
      expect(createEmbeddingProvider(cfg(full))).toBeNull();
    });
    it("builds an OpenAiEmbeddingProvider when everything present", () => {
      const p = createEmbeddingProvider(cfg(full), { http: new FakeHttpClient() });
      expect(p).toBeInstanceOf(OpenAiEmbeddingProvider);
      expect(p?.id).toBe("openai-compatible");
    });
    it("returns null when apiKey is whitespace-only", () => {
      const p = createEmbeddingProvider(cfg({ ...full, apiKey: "   " }), { http: new FakeHttpClient() });
      expect(p).toBeNull();
    });
  });
});
