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

export const SETTINGS_SCHEMA_VERSION = 7;

export type EmbeddingProviderId = "none" | "mock" | "ollama" | "openai-compatible";

/** How retrieval combines lexical (BM25) and vector (cosine) signals. */
export type RetrievalMode = "lexical" | "hybrid" | "vector";

export const RETRIEVAL_MODES: RetrievalMode[] = ["lexical", "hybrid", "vector"];
export const EMBEDDING_PROVIDERS: EmbeddingProviderId[] = [
  "none",
  "mock",
  "ollama",
  "openai-compatible",
];

/** Bounds for the embedding batch size (chunks per provider request). */
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 512;
const DEFAULT_BATCH_SIZE = 16;

export interface ServerSettings {
  enabled: boolean;
  host: string;
  port: number;
  token: string;
  /**
   * Explicit opt-in to bind a non-loopback host. Off by default: the server
   * REFUSES to start on a non-localhost address unless this is true AND a token
   * is set, so memory is never exposed to the network by accident.
   */
  allowNonLocalhost: boolean;
}

/**
 * Reductions applied to what the MCP tools return. Each trims redundancy at the
 * cost of returning less than the index holds, so each is a separate opt-in
 * rather than one blanket switch: they answer different questions, and a user
 * who wants every copy of a memory may still want long notes merged sensibly.
 * All default OFF.
 *
 * The hard output caps (`maxChars`, the related-link, project-list, and summary budgets) are
 * deliberately NOT here: they bound worst-case output size rather than
 * exercising judgement about content, so they always apply.
 */
export interface ContextSavingsSettings {
  /** Drop a hit whose text nearly repeats a higher-ranked one (token overlap ≥ 0.8). */
  collapseNearDuplicates: boolean;
  /** Cap how much of a single result page one note may fill. */
  capPerNoteShare: boolean;
  /** Merge a section's consecutive windows on a full-note read, stripping the repeated carry. */
  mergeOverlappingPassages: boolean;
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
  /** Index binary attachments (v1: PDF text via Obsidian's bundled pdf.js).
   * Off by default: extraction is local-only, but indexing attachment text
   * makes it searchable and readable over the MCP server like any note. */
  indexAttachments: boolean;
  /**
   * Index text found IN IMAGES, by delegating to the Text Extractor companion
   * plugin when it is installed. Off by default and separate from
   * `indexAttachments`: that plugin downloads OCR language data on first use,
   * so this is the one attachment path that can touch the network — through a
   * plugin the user installed themselves, not through us.
   */
  indexImageText: boolean;
  embeddingProvider: EmbeddingProviderId;
  embeddingModel: string;
  /** Base URL for network providers (Ollama / OpenAI-compatible). */
  embeddingEndpoint: string;
  /** Secret API key for the OpenAI-compatible provider. Never logged. */
  embeddingApiKey: string;
  /** Chunks per embedding request. Bounds sustained memory/network use. */
  embeddingBatchSize: number;
  /** How retrieval combines lexical and vector signals (with a provider set). */
  retrievalMode: RetrievalMode;
  server: ServerSettings;
  contextSavings: ContextSavingsSettings;
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
  indexAttachments: false,
  indexImageText: false,
  embeddingProvider: "none",
  embeddingModel: "",
  embeddingEndpoint: "",
  embeddingApiKey: "",
  embeddingBatchSize: DEFAULT_BATCH_SIZE,
  retrievalMode: "hybrid",
  server: {
    enabled: false,
    host: "127.0.0.1",
    port: 3999,
    token: "",
    allowNonLocalhost: false,
  },
  contextSavings: {
    collapseNearDuplicates: false,
    capPerNoteShare: false,
    mergeOverlappingPassages: false,
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
    contextSavings: legacyContextSavings(data.contextSavings),
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
  if (!EMBEDDING_PROVIDERS.includes(merged.embeddingProvider)) {
    merged.embeddingProvider = "none";
  }
  if (!RETRIEVAL_MODES.includes(merged.retrievalMode)) {
    merged.retrievalMode = DEFAULT_SETTINGS.retrievalMode;
  }
  merged.embeddingModel = typeof merged.embeddingModel === "string" ? merged.embeddingModel : "";
  merged.embeddingEndpoint =
    typeof merged.embeddingEndpoint === "string" ? merged.embeddingEndpoint : "";
  merged.embeddingApiKey =
    typeof merged.embeddingApiKey === "string" ? merged.embeddingApiKey : "";
  const parsedBatch = Math.trunc(Number(merged.embeddingBatchSize));
  merged.embeddingBatchSize = Number.isFinite(parsedBatch)
    ? clamp(parsedBatch, MIN_BATCH_SIZE, MAX_BATCH_SIZE)
    : DEFAULT_BATCH_SIZE;
  // Repair the persisted port by clamping into the valid range; a non-numeric
  // value falls back to the default. Note the finite check is separate from the
  // clamp so a legitimate 0 is clamped to 1 rather than being treated as absent
  // (the old `Number(port) || DEFAULT` idiom mishandled 0). Port 0 as
  // "OS-assigned" is a runtime/test affordance passed straight to the server,
  // not a persistable setting.
  const parsedPort = Math.trunc(Number(merged.server.port));
  merged.server.port = Number.isFinite(parsedPort)
    ? clamp(parsedPort, 1, 65535)
    : DEFAULT_SETTINGS.server.port;
  if (typeof merged.server.host !== "string" || merged.server.host.trim() === "") {
    merged.server.host = DEFAULT_SETTINGS.server.host;
  }

  // Coerce the safety-critical booleans explicitly. The spread above would copy
  // a hostile/corrupt blob's values verbatim (e.g. a string "yes"), so we
  // re-assert them here. Defaults bias to the SAFE direction: opt-in flags
  // default false, protective flags (appendOnly) default true.
  merged.indexingEnabled = coerceBool(data.indexingEnabled, DEFAULT_SETTINGS.indexingEnabled);
  merged.autoIndexOnChange = coerceBool(data.autoIndexOnChange, DEFAULT_SETTINGS.autoIndexOnChange);
  merged.indexAttachments = coerceBool(data.indexAttachments, DEFAULT_SETTINGS.indexAttachments);
  merged.indexImageText = coerceBool(data.indexImageText, DEFAULT_SETTINGS.indexImageText);
  merged.allowDirectWrites = coerceBool(data.allowDirectWrites, DEFAULT_SETTINGS.allowDirectWrites);
  merged.appendOnly = coerceBool(data.appendOnly, DEFAULT_SETTINGS.appendOnly);
  merged.debugLogging = coerceBool(data.debugLogging, DEFAULT_SETTINGS.debugLogging);
  merged.server.enabled = coerceBool(data.server?.enabled, DEFAULT_SETTINGS.server.enabled);
  merged.server.allowNonLocalhost = coerceBool(
    data.server?.allowNonLocalhost,
    DEFAULT_SETTINGS.server.allowNonLocalhost,
  );

  // --- migration ladder (future versions add cases here) ---
  // v(unknown) -> v1: initial schema; nothing structural to change.
  // v1 -> v2: added server.allowNonLocalhost (defaulted safely above). No data
  //   transform needed — the safe default is applied when the field is absent.
  // v2 -> v3: added embeddingEndpoint / embeddingApiKey / embeddingBatchSize /
  //   retrievalMode for M3 vector + hybrid retrieval. All default safely (empty
  //   config => provider degrades to lexical), so absent fields need no transform.
  merged.schemaVersion = SETTINGS_SCHEMA_VERSION;
  return merged;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((v): v is string => typeof v === "string");
}

/** Coerce a persisted value to a strict boolean; non-booleans fall back safely. */
/**
 * Read the context-savings group, tolerating the schema-v5 shape.
 *
 * v5 stored a single `contextSavings` boolean covering all three reductions.
 * Spreading that boolean would yield no keys and silently reset a user who had
 * opted in, so a legacy `true` turns all three on — the behaviour they chose —
 * and each key is coerced individually so a corrupt blob can't smuggle a
 * non-boolean through.
 */
function legacyContextSavings(value: unknown): ContextSavingsSettings {
  if (typeof value === "boolean") {
    return { collapseNearDuplicates: value, capPerNoteShare: value, mergeOverlappingPassages: value };
  }
  const obj = (value && typeof value === "object" ? value : {}) as Partial<ContextSavingsSettings>;
  const d = DEFAULT_SETTINGS.contextSavings;
  return {
    collapseNearDuplicates: coerceBool(obj.collapseNearDuplicates, d.collapseNearDuplicates),
    capPerNoteShare: coerceBool(obj.capPerNoteShare, d.capPerNoteShare),
    mergeOverlappingPassages: coerceBool(obj.mergeOverlappingPassages, d.mergeOverlappingPassages),
  };
}

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
    // In ScanConfig so the scan-config key machinery invalidates the
    // skip-unchanged fast path and fires the config refresh when toggled.
    indexAttachments: settings.indexAttachments,
  };
}

export function toEmbeddingConfig(settings: EngramSettings): {
  provider: EmbeddingProviderId;
  model: string;
  endpoint: string;
  apiKey: string;
} {
  return {
    provider: settings.embeddingProvider,
    model: settings.embeddingModel,
    endpoint: settings.embeddingEndpoint,
    apiKey: settings.embeddingApiKey,
  };
}

export function toMemoryLayout(_settings: EngramSettings): MemoryLayoutConfig {
  // M1 uses the default subfolder layout. Renaming is a future setting; the
  // resolver already validates any override stays inside the root.
  return DEFAULT_LAYOUT;
}
