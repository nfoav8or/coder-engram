import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  migrateSettings,
  parseList,
  toScanConfig,
  SETTINGS_SCHEMA_VERSION,
} from "../src/settings/settings";

describe("DEFAULT_SETTINGS safe defaults", () => {
  it("keeps the server disabled and localhost-bound", () => {
    expect(DEFAULT_SETTINGS.server.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.server.host).toBe("127.0.0.1");
  });
  it("keeps writes safe: inbox-only and append-only", () => {
    expect(DEFAULT_SETTINGS.allowDirectWrites).toBe(false);
    expect(DEFAULT_SETTINGS.appendOnly).toBe(true);
  });
  it("defaults the memory root to Claude Code", () => {
    expect(DEFAULT_SETTINGS.memoryRoot).toBe("Claude Code");
  });
  it("requires no cloud provider by default", () => {
    expect(DEFAULT_SETTINGS.embeddingProvider).toBe("none");
  });
  it("does not auto-index on change by default", () => {
    expect(DEFAULT_SETTINGS.autoIndexOnChange).toBe(false);
  });
});

describe("migrateSettings", () => {
  it("returns defaults for empty/undefined input", () => {
    expect(migrateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("preserves user values while stamping the schema version", () => {
    const migrated = migrateSettings({ memoryRoot: "Brain", server: { enabled: true, port: 4000 } });
    expect(migrated.memoryRoot).toBe("Brain");
    expect(migrated.server.enabled).toBe(true);
    expect(migrated.server.port).toBe(4000);
    expect(migrated.server.host).toBe("127.0.0.1"); // filled from defaults
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it("repairs an out-of-range port", () => {
    expect(migrateSettings({ server: { port: 999999 } }).server.port).toBe(65535);
    expect(migrateSettings({ server: { port: -5 } }).server.port).toBe(1);
  });

  it("falls back to a valid memory root when blank", () => {
    expect(migrateSettings({ memoryRoot: "   " }).memoryRoot).toBe("Claude Code");
  });

  it("rejects a memory root that would escape the vault", () => {
    expect(migrateSettings({ memoryRoot: "../escape" }).memoryRoot).toBe("Claude Code");
    expect(migrateSettings({ memoryRoot: "/etc/passwd" }).memoryRoot).toBe("Claude Code");
  });

  it("normalizes a valid but messy memory root", () => {
    expect(migrateSettings({ memoryRoot: "Brain//Sub/" }).memoryRoot).toBe("Brain/Sub");
  });

  it("drops an invalid embedding provider", () => {
    expect(migrateSettings({ embeddingProvider: "evil" }).embeddingProvider).toBe("none");
  });

  it("ignores non-array list fields", () => {
    expect(migrateSettings({ excludedFolders: "not-an-array" }).excludedFolders).toEqual([]);
  });

  it("does not throw on a garbage blob", () => {
    expect(() => migrateSettings(42)).not.toThrow();
    expect(() => migrateSettings("nope")).not.toThrow();
  });

  it("coerces a non-string server token to the safe empty default", () => {
    // A number/null token from a corrupt blob previously flowed through
    // untouched and threw at startup where validateConfig/checkAuth .trim() it.
    // Empty is the safe direction: the server refuses to start without a token.
    expect(migrateSettings({ server: { token: 12345 } }).server.token).toBe("");
    expect(migrateSettings({ server: { token: null } }).server.token).toBe("");
    expect(migrateSettings({ server: { token: "keep-me" } }).server.token).toBe("keep-me");
  });
});

describe("parseList", () => {
  it("splits on newlines and commas and trims", () => {
    expect(parseList("a, b\nc")).toEqual(["a", "b", "c"]);
    expect(parseList("  ")).toEqual([]);
  });
});

describe("toScanConfig", () => {
  it("projects settings into a scan config", () => {
    const cfg = toScanConfig({ ...DEFAULT_SETTINGS, excludedFolders: ["Private"] });
    expect(cfg.excludedFolders).toEqual(["Private"]);
  });
});
