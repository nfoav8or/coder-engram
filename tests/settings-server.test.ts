import { describe, it, expect } from "vitest";
import { migrateSettings, DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION } from "../src/settings/settings";

describe("settings migration — server security fields (v2)", () => {
  it("defaults allowNonLocalhost to false for legacy (v1) settings", () => {
    const legacy = { schemaVersion: 1, server: { enabled: true, host: "127.0.0.1", port: 3999, token: "" } };
    const migrated = migrateSettings(legacy);
    expect(migrated.server.allowNonLocalhost).toBe(false);
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it("coerces a non-boolean allowNonLocalhost from a hostile blob to the safe default", () => {
    const hostile = { server: { allowNonLocalhost: "yes", enabled: "true" } };
    const migrated = migrateSettings(hostile);
    expect(migrated.server.allowNonLocalhost).toBe(false);
    expect(migrated.server.enabled).toBe(false);
  });

  it("preserves an explicit true allowNonLocalhost", () => {
    const migrated = migrateSettings({ server: { allowNonLocalhost: true } });
    expect(migrated.server.allowNonLocalhost).toBe(true);
  });

  it("keeps the safe server defaults when server is absent", () => {
    const migrated = migrateSettings({});
    expect(migrated.server).toEqual(DEFAULT_SETTINGS.server);
  });
});
