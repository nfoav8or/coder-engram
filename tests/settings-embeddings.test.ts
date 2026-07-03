import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  migrateSettings,
  toEmbeddingConfig,
  SETTINGS_SCHEMA_VERSION,
} from "../src/settings/settings";

describe("M3 settings schema (v3)", () => {
  it("is schema version 3", () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(3);
  });

  it("has safe M3 defaults", () => {
    expect(DEFAULT_SETTINGS.embeddingEndpoint).toBe("");
    expect(DEFAULT_SETTINGS.embeddingApiKey).toBe("");
    expect(DEFAULT_SETTINGS.embeddingBatchSize).toBe(16);
    expect(DEFAULT_SETTINGS.retrievalMode).toBe("hybrid");
  });
});

describe("migrateSettings M3 fields", () => {
  it("falls back to hybrid for an invalid retrieval mode", () => {
    expect(migrateSettings({ retrievalMode: "evil" }).retrievalMode).toBe("hybrid");
  });

  it("preserves a valid retrieval mode", () => {
    expect(migrateSettings({ retrievalMode: "vector" }).retrievalMode).toBe("vector");
    expect(migrateSettings({ retrievalMode: "lexical" }).retrievalMode).toBe("lexical");
  });

  it("clamps a too-small batch size up to 1", () => {
    expect(migrateSettings({ embeddingBatchSize: 0 }).embeddingBatchSize).toBe(1);
  });

  it("clamps a too-large batch size down to 512", () => {
    expect(migrateSettings({ embeddingBatchSize: 9999 }).embeddingBatchSize).toBe(512);
  });

  it("falls back to 16 for a non-finite batch size", () => {
    expect(migrateSettings({ embeddingBatchSize: "x" }).embeddingBatchSize).toBe(16);
  });

  it("coerces a non-string endpoint to empty", () => {
    expect(migrateSettings({ embeddingEndpoint: 123 }).embeddingEndpoint).toBe("");
  });

  it("coerces a non-string apiKey to empty", () => {
    expect(migrateSettings({ embeddingApiKey: { secret: true } }).embeddingApiKey).toBe("");
  });

  it("preserves valid string endpoint/apiKey values", () => {
    const m = migrateSettings({ embeddingEndpoint: "http://x:11434", embeddingApiKey: "sk-1" });
    expect(m.embeddingEndpoint).toBe("http://x:11434");
    expect(m.embeddingApiKey).toBe("sk-1");
  });
});

describe("toEmbeddingConfig", () => {
  it("maps settings fields into the embedding config", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      embeddingProvider: "openai-compatible" as const,
      embeddingModel: "text-embed",
      embeddingEndpoint: "http://x/v1",
      embeddingApiKey: "sk-9",
    };
    expect(toEmbeddingConfig(settings)).toEqual({
      provider: "openai-compatible",
      model: "text-embed",
      endpoint: "http://x/v1",
      apiKey: "sk-9",
    });
  });
});
