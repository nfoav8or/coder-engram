/**
 * settings — the persisted settings model, safe defaults, and migration.
 *
 * SAFETY-CRITICAL DEFAULTS:
 *   - server.enabled: false        (never listen unless the user opts in)
 *   - server.host: "127.0.0.1"     (localhost only)
 *   - allowDirectWrites: false     (writes go to the review inbox)
 *   - appendOnly: true             (never overwrite memory)
 *   - debugLogging: false          (no console noise; secrets redacted when on)
 */

import { DEFAULT_LAYOUT, MemoryLayoutConfig } from "../memory/memory-types";
import { ScanConfig } from "../indexing/vault-scanner";
import { clamp } from "../utils/validation";
import { normalizeVaultRelativePath } from "../utils/paths";

export const SETTINGS_SCHEMA_VERSION = 1;

export type EmbeddingProviderId = "none" | "mock" | "ollama" | "openai-compatible";

export interface ServerSettings {
  enabled: boolean;
  host: string;
  port: number;
  token: string;
}

export interface EngramSettings {
  schemaVersion: number;
  indexingEnabled: boolean;
  memoryRoot: string;
  includedFolders: string[];
  excludedFolders: string[];
  excludedTags: string[];
  excludedPathPatterns: string[];
  defaultProject: string;
  autoIndexOnChange: boolean;
  embeddingProvider: EmbeddingProviderId;
  embeddingModel: string;
  server: ServerSettings;
  allowDirectWrites: boolean;
  appendOnly: boolean;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: EngramSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  indexingEnabled: true,
  memoryRoot: "Claude Code",
  includedFolders: [],
  excludedFolders: [],
  excludedTags: [],
  excludedPathPatterns: [],
  defaultProject: "",
  autoIndexOnChange: false,
  embeddingProvider: "none",
  embeddingModel: "",
  server: {
    enabled: false,
    host: "127.0.0.1",
    port: 3999,
    token: "",
  },
  allowDirectWrites: false,
  appendOnly: true,
  debugLogging: false,
};

/**
 * Merge persisted data over defaults and run the migration ladder. Unknown /
 * missing fields fall back to safe defaults; malformed types are coerced or
 * dropped. Never throws — a corrupt settings blob degrades to defaults.
 */
export function migrateSettings(raw: unknown): EngramSettings {
  const data = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Partial<EngramSettings> & { server?: Partial<ServerSettings> };

  const merged: EngramSettings = {
    ...DEFAULT_SETTINGS,
    ...data,
    server: { ...DEFAULT_SETTINGS.server, ...(data.server ?? {}) },
    // Arrays: only accept real string arrays.
    includedFolders: asStringArray(data.includedFolders, DEFAULT_SETTINGS.includedFolders),
    excludedFolders: asStringArray(data.excludedFolders, DEFAULT_SETTINGS.excludedFolders),
    excludedTags: asStringArray(data.excludedTags, DEFAULT_SETTINGS.excludedTags),
    excludedPathPatterns: asStringArray(data.excludedPathPatterns, DEFAULT_SETTINGS.excludedPathPatterns),
  };

  // Coerce/repair critical fields. The memory root must be a valid, in-vault
  // relative path; a blank or escaping value (e.g. "../x" from a hostile or
  // corrupt blob) falls back to the safe default rather than crashing load.
  if (typeof merged.memoryRoot !== "string" || merged.memoryRoot.trim() === "") {
    merged.memoryRoot = DEFAULT_SETTINGS.memoryRoot;
  } else {
    try {
      merged.memoryRoot = normalizeVaultRelativePath(merged.memoryRoot);
    } catch {
      merged.memoryRoot = DEFAULT_SETTINGS.memoryRoot;
    }
  }
  if (!["none", "mock", "ollama", "openai-compatible"].includes(merged.embeddingProvider)) {
    merged.embeddingProvider = "none";
  }
  merged.server.port = clamp(Math.trunc(Number(merged.server.port) || DEFAULT_SETTINGS.server.port), 1, 65535);
  if (typeof merged.server.host !== "string" || merged.server.host.trim() === "") {
    merged.server.host = DEFAULT_SETTINGS.server.host;
  }

  // Coerce the safety-critical booleans explicitly. The spread above would copy
  // a hostile/corrupt blob's values verbatim (e.g. a string "yes"), so we
  // re-assert them here. Defaults bias to the SAFE direction: opt-in flags
  // default false, protective flags (appendOnly) default true.
  merged.indexingEnabled = coerceBool(data.indexingEnabled, DEFAULT_SETTINGS.indexingEnabled);
  merged.autoIndexOnChange = coerceBool(data.autoIndexOnChange, DEFAULT_SETTINGS.autoIndexOnChange);
  merged.allowDirectWrites = coerceBool(data.allowDirectWrites, DEFAULT_SETTINGS.allowDirectWrites);
  merged.appendOnly = coerceBool(data.appendOnly, DEFAULT_SETTINGS.appendOnly);
  merged.debugLogging = coerceBool(data.debugLogging, DEFAULT_SETTINGS.debugLogging);
  merged.server.enabled = coerceBool(data.server?.enabled, DEFAULT_SETTINGS.server.enabled);

  // --- migration ladder (future versions add cases here) ---
  // v(unknown) -> v1: nothing structural to change; just stamp the version.
  merged.schemaVersion = SETTINGS_SCHEMA_VERSION;
  return merged;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((v): v is string => typeof v === "string");
}

/** Coerce a persisted value to a strict boolean; non-booleans fall back safely. */
function coerceBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Parse a newline/comma-separated textarea value into a trimmed string list. */
export function parseList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function toScanConfig(settings: EngramSettings): ScanConfig {
  return {
    includedFolders: settings.includedFolders,
    excludedFolders: settings.excludedFolders,
    excludedTags: settings.excludedTags,
    excludedPathPatterns: settings.excludedPathPatterns,
  };
}

export function toMemoryLayout(_settings: EngramSettings): MemoryLayoutConfig {
  // M1 uses the default subfolder layout. Renaming is a future setting; the
  // resolver already validates any override stays inside the root.
  return DEFAULT_LAYOUT;
}
