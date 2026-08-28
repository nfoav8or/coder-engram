/**
 * setting-definitions — the settings tab as DATA.
 *
 * Obsidian 1.13 replaced the imperative `display()` with a declarative
 * `getSettingDefinitions()`, and a tab that only implements `display()` is
 * absent from settings search — a real loss for a plugin with this many
 * toggles. This module is that description, and `settings-tab.ts` is the thin
 * shell that hands it to Obsidian (or falls back to `display()` on an app
 * older than 1.13, which never calls this).
 *
 * It is a separate module for one concrete reason: everything here imports
 * `obsidian` for TYPES ONLY, so the import is erased and the schema can be
 * unit-tested in the Node test environment. `settings-tab.ts` extends
 * `PluginSettingTab`, a runtime value, and can never be. What used to be
 * ~30 settings of untestable UI code is now a value this suite asserts over —
 * which is how a control that reads or writes the wrong key gets caught.
 *
 * Values move through `key`, a dotted path into `EngramSettings`
 * (`server.host`, `contextSavings.capPerNoteShare`). `readSettingValue` and
 * `writeSettingValue` below are the only translation between that path and
 * the stored shape, and they are what the setting tab's `getControlValue` /
 * `setControlValue` delegate to.
 */

import type { SettingDefinitionItem, Setting } from "obsidian";
import { EngramSettings, EMBEDDING_PROVIDERS, RETRIEVAL_MODES, parseList } from "./settings";
import { normalizeVaultRelativePath } from "../utils/paths";
import { toMessage } from "../utils/errors";

/** Keys whose stored value is a string list but whose control is a textarea. */
const LIST_KEYS = [
  "includedFolders",
  "excludedFolders",
  "excludedTags",
  "excludedPathPatterns",
] as const;

type ListKey = (typeof LIST_KEYS)[number];

function isListKey(key: string): key is ListKey {
  return (LIST_KEYS as readonly string[]).includes(key);
}

/** What the definitions need from the host beyond the settings themselves. */
export interface DefinitionContext {
  /** The live settings object. Read at render time, never copied. */
  settings: EngramSettings;
  /** Surface a message to the user (a `Notice` in production). */
  notify(message: string): void;
  /** Discard and rebuild the index. */
  rebuildIndex(): Promise<void>;
  /** Persist a changed value and let the host react (server rebind, reindex). */
  commit(): void;
  /** Fresh random server token. */
  generateToken(): string;
  /** Re-read the definitions — for changes that alter descriptions or structure. */
  update(): void;
}

/**
 * Read the value a control should display.
 *
 * Returning `undefined` for an unknown key rather than throwing: a definition
 * naming a key that does not exist is a programming error, but one that must
 * not take the whole settings tab down with it.
 */
export function readSettingValue(settings: EngramSettings, key: string): unknown {
  if (isListKey(key)) return settings[key].join("\n");
  const parts = key.split(".");
  let cursor: unknown = settings;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * Write a value a control produced, coercing it to the stored shape.
 *
 * Text controls hand back strings that the settings model does not store
 * verbatim — a list is lines, a memory root is normalized, a token is trimmed —
 * so the coercion lives here rather than in each definition.
 */
export function writeSettingValue(settings: EngramSettings, key: string, value: unknown): void {
  if (isListKey(key)) {
    settings[key] = parseList(typeof value === "string" ? value : "");
    return;
  }
  if (key === "memoryRoot") {
    const raw = typeof value === "string" ? value.trim() : "";
    // Already accepted by `validate`; normalize so "Notes/" and "./Notes" are
    // stored the way every other path in the plugin is written.
    settings.memoryRoot = normalizeVaultRelativePath(raw || "Claude Code");
    return;
  }
  const parts = key.split(".");
  const last = parts.pop();
  if (last === undefined) return;
  let cursor: Record<string, unknown> = settings as unknown as Record<string, unknown>;
  for (const part of parts) {
    const next = cursor[part];
    if (next === null || typeof next !== "object") return;
    cursor = next as Record<string, unknown>;
  }
  cursor[last] = typeof value === "string" && TRIMMED_KEYS.has(key) ? value.trim() : value;
}

/**
 * Reject a number outside its range, as an inline message.
 *
 * `min` and `max` on a number control are hints to the input element, not a
 * bound the framework enforces — Obsidian's own docs list `number` among the
 * controls where "the user can enter values the bind's type alone can't
 * constrain", which is what `validate` is for. The imperative tab guarded these
 * two fields by silently ignoring a bad value; saying so is better.
 */
function inRange(label: string, min: number, max: number) {
  return (value: number): string | undefined => {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
      return `${label} must be a whole number from ${min} to ${max}.`;
    }
    return undefined;
  };
}

/** Text keys stored trimmed: a stray space in a token or URL is never meant. */
const TRIMMED_KEYS = new Set([
  "defaultProject",
  "embeddingModel",
  "embeddingEndpoint",
  "embeddingApiKey",
  "server.host",
  "server.token",
]);

/** A password-masked text row, which the declarative controls cannot express. */
function secretRow(
  setting: Setting,
  current: () => string,
  placeholder: string,
  onChange: (value: string) => void,
): void {
  setting.addText((text) => {
    text.setPlaceholder(placeholder).setValue(current()).onChange(onChange);
    text.inputEl.type = "password";
  });
}

/**
 * The whole settings tab, as definitions.
 *
 * Called on every render, so anything provider-dependent (a description that
 * names Ollama rather than OpenAI) is computed fresh here, while cheap
 * show/hide decisions are `visible` predicates the app re-evaluates itself.
 */
export function buildSettingDefinitions(ctx: DefinitionContext): SettingDefinitionItem[] {
  const s = ctx.settings;
  const usesEndpoint = (): boolean =>
    s.embeddingProvider === "ollama" || s.embeddingProvider === "openai-compatible";
  const isOpenAiCompatible = (): boolean => s.embeddingProvider === "openai-compatible";

  return [
    {
      type: "group",
      heading: "Indexing",
      items: [
        {
          // The imperative tab opened with this as a plain paragraph above the
          // first heading, and the declarative path had no equivalent — so from
          // 1.13 onward, where Obsidian ignores `display()` entirely, nobody
          // has been shown it. It is the one place the settings UI states the
          // containment guarantee the whole design rests on, which is why it is
          // restored here rather than dropped along with `display()`.
          name: "Where memory is stored",
          searchable: false,
          render: (setting: Setting) => {
            setting.setDesc(
              "All plugin-managed memory lives inside this vault, under the memory root below. " +
                "Nothing is written outside the vault.",
            );
          },
        },
        {
          name: "Enable indexing",
          desc: "Scan and index vault notes for retrieval.",
          control: { type: "toggle", key: "indexingEnabled" },
        },
        {
          name: "Memory root",
          desc: "Vault-relative folder for plugin-managed memory. Must stay inside the vault.",
          control: {
            type: "text",
            key: "memoryRoot",
            placeholder: "Claude Code",
            // Rejected inline instead of committed and undone: a root that
            // escapes the vault must never reach the path resolver, and the
            // imperative tab could only say so in a Notice after the fact.
            validate: (value: string): string | undefined => {
              const raw = value.trim();
              // Empty falls back to the default root rather than failing.
              if (raw === "") return undefined;
              try {
                normalizeVaultRelativePath(raw);
                return undefined;
              } catch {
                return "Must be a relative path inside the vault.";
              }
            },
          },
        },
        {
          name: "Included folders",
          desc: "Allowlist (one per line or comma-separated). Empty = whole vault.",
          control: { type: "textarea", key: "includedFolders", rows: 3 },
        },
        {
          name: "Excluded folders",
          desc: "Denylist of folders to skip.",
          control: { type: "textarea", key: "excludedFolders", rows: 3 },
        },
        {
          name: "Excluded tags",
          desc: "Notes carrying any of these tags are never indexed.",
          control: { type: "textarea", key: "excludedTags", rows: 3 },
        },
        {
          name: "Excluded path patterns",
          desc: "Glob (*, **) or substring patterns for sensitive notes to skip.",
          control: { type: "textarea", key: "excludedPathPatterns", rows: 3 },
        },
        {
          name: "Index attachments",
          desc:
            "Extract and index text from PDFs (via Obsidian's built-in PDF engine), " +
            "Office documents (docx/pptx/xlsx, odt/odp/ods, rtf), plain text " +
            "(txt/csv), and Canvas text cards. Fully local. Indexed attachment " +
            "text becomes searchable and readable over the local server, like " +
            "any note; exclusions apply to attachments too.",
          control: { type: "toggle", key: "indexAttachments" },
        },
        {
          name: "Index text inside images (needs Text Extractor)",
          desc:
            "Read text out of PNG/JPG/WEBP/BMP attachments by delegating to the Text Extractor " +
            "plugin, if you have it installed and enabled. Nothing happens without it, and " +
            "nothing happens unless Index attachments is on above. " +
            "Note that Text Extractor downloads OCR language data from the internet on first " +
            "use — the only attachment path here that touches the network, and it belongs to " +
            "that plugin, not this one.",
          aliases: ["ocr", "image text"],
          control: { type: "toggle", key: "indexImageText", disabled: () => !s.indexAttachments },
        },
        {
          name: "Auto-index on file change",
          desc: "Debounced refresh when notes change. Off by default.",
          control: { type: "toggle", key: "autoIndexOnChange" },
        },
        {
          name: "Default project",
          desc: "Used by project-context and add-to-project commands.",
          control: { type: "text", key: "defaultProject" },
        },
        {
          name: "Rebuild index",
          desc: "Discard and rebuild the index from scratch.",
          action: () => {
            ctx.notify("Rebuilding index…");
            void ctx
              .rebuildIndex()
              .then(() => ctx.notify("Index rebuilt."))
              .catch((err: unknown) => ctx.notify(`Rebuild failed: ${toMessage(err)}`));
          },
        },
      ],
    },
    {
      type: "group",
      heading: "Retrieval & embeddings",
      items: [
        {
          name: "Embedding provider",
          desc:
            "None keeps retrieval fully offline (lexical BM25). Mock is deterministic hashing for " +
            "development. Ollama (local) and OpenAI-compatible enable vector + hybrid retrieval.",
          aliases: [...EMBEDDING_PROVIDERS],
          control: {
            type: "dropdown",
            key: "embeddingProvider",
            options: {
              none: "None (lexical BM25)",
              mock: "Mock (development)",
              ollama: "Ollama (local)",
              "openai-compatible": "OpenAI-compatible",
            },
          },
        },
        {
          name: "Retrieval mode",
          desc:
            "How results are ranked when a provider is set. Hybrid fuses lexical + vector (recommended); " +
            "Vector is embeddings-only; Lexical ignores embeddings. Always lexical when the provider is None.",
          aliases: [...RETRIEVAL_MODES],
          control: {
            type: "dropdown",
            key: "retrievalMode",
            options: {
              hybrid: "Hybrid (lexical + vector)",
              vector: "Vector only",
              lexical: "Lexical only",
            },
          },
        },
        {
          name: "Embedding model",
          desc:
            s.embeddingProvider === "ollama"
              ? "Ollama model name, e.g. nomic-embed-text or mxbai-embed-large."
              : "Model name, e.g. text-embedding-3-small.",
          visible: usesEndpoint,
          control: { type: "text", key: "embeddingModel" },
        },
        {
          name: "Endpoint",
          desc:
            s.embeddingProvider === "ollama"
              ? "Base URL of the Ollama server. Default http://127.0.0.1:11434."
              : "Base URL of the OpenAI-compatible API, including any version prefix (e.g. https://api.openai.com/v1).",
          visible: usesEndpoint,
          control: {
            type: "text",
            key: "embeddingEndpoint",
            placeholder:
              s.embeddingProvider === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1",
          },
        },
        {
          name: "API key",
          desc: "Bearer token for the endpoint. Stored locally and never logged.",
          visible: isOpenAiCompatible,
          // Rendered rather than declared: the declarative text control has no
          // masked variant, and a secret must not sit on screen in clear text.
          render: (setting: Setting) =>
            secretRow(
              setting,
              () => s.embeddingApiKey,
              "(required)",
              (value) => {
                writeSettingValue(s, "embeddingApiKey", value);
                ctx.commit();
              },
            ),
        },
        {
          name: "Batch size",
          desc: "Chunks per embedding request (1–512). Lower this if the provider rejects large batches.",
          visible: usesEndpoint,
          control: {
            type: "number",
            key: "embeddingBatchSize",
            min: 1,
            max: 512,
            step: 1,
            validate: inRange("Batch size", 1, 512),
          },
        },
        {
          name: "Concurrent batches",
          desc:
            "Embedding batches in flight at once (1–8). Keep at 1 for hosted APIs so their rate " +
            "limits are respected; 2–4 speeds up the first pass against a local Ollama.",
          visible: usesEndpoint,
          control: {
            type: "number",
            key: "embeddingConcurrency",
            min: 1,
            max: 8,
            step: 1,
            validate: inRange("Concurrent batches", 1, 8),
          },
        },
      ],
    },
    {
      type: "group",
      heading: "Local server (Claude Code / MCP bridge)",
      cls: "engram-server-group",
      items: [
        {
          name: "Security notice",
          searchable: false,
          render: (setting: Setting) => {
            setting.setDesc(
              "The local server lets external tools query and propose memory. Keep it bound to " +
                "127.0.0.1, set a token, and only enable it while you need it. Never bind to a " +
                "public interface.",
            );
            setting.settingEl.addClass("engram-security-warning");
          },
        },
        {
          name: "Enable local server",
          desc: "Disabled by default. Starts a localhost bridge for Claude Code.",
          control: { type: "toggle", key: "server.enabled" },
        },
        {
          name: "Host",
          desc: "Bind address. Leave as 127.0.0.1 unless you fully understand the risk.",
          control: { type: "text", key: "server.host", placeholder: "127.0.0.1" },
        },
        {
          name: "Allow non-localhost binding",
          desc:
            "Off by default. Required (together with a token) before the server will bind to any " +
            "address other than localhost. Leave OFF unless you fully understand the risk.",
          control: { type: "toggle", key: "server.allowNonLocalhost" },
        },
        {
          name: "Port",
          control: {
            type: "number",
            key: "server.port",
            min: 1,
            max: 65535,
            step: 1,
            validate: inRange("Port", 1, 65535),
          },
        },
        {
          name: "Token",
          desc: "Required auth token for server requests. Strongly recommended; mandatory for non-localhost.",
          render: (setting: Setting) => {
            secretRow(
              setting,
              () => s.server.token,
              "(set a strong token)",
              (value) => {
                writeSettingValue(s, "server.token", value);
                ctx.commit();
              },
            );
            setting.addButton((button) =>
              button.setButtonText("Generate").onClick(() => {
                s.server.token = ctx.generateToken();
                ctx.commit();
                ctx.update();
                ctx.notify("Generated a new server token.");
              }),
            );
          },
        },
      ],
    },
    {
      type: "group",
      heading: "Memory write safety",
      items: [
        {
          name: "Allow direct memory writes",
          desc: "When OFF (default), all writes go to the review inbox. When ON, tools may write memory files directly.",
          control: { type: "toggle", key: "allowDirectWrites" },
        },
        {
          name: "Append-only writes",
          desc: "When ON (default), writes only append and never overwrite existing memory.",
          control: { type: "toggle", key: "appendOnly" },
        },
      ],
    },
    {
      type: "group",
      heading: "Context savings for Claude Code",
      items: [
        {
          name: "About context savings",
          searchable: false,
          render: (setting: Setting) => {
            setting.setDesc(
              "Each trims redundancy from what the MCP tools return, and each can hide something " +
                "you wanted to see, so they are chosen individually and all start off. Output size " +
                "caps apply either way.",
            );
          },
        },
        {
          name: "Collapse near-duplicate hits",
          desc: "A search hit whose text nearly repeats a higher-ranked one is dropped. Saves repeating a memory recorded in two places — at the cost of not showing that both copies exist.",
          control: { type: "toggle", key: "contextSavings.collapseNearDuplicates" },
        },
        {
          name: "Cap one note's share of a page",
          desc: "Stops a single long note filling the whole result page, leaving room for other notes. Its lower-ranked passages are held back.",
          control: { type: "toggle", key: "contextSavings.capPerNoteShare" },
        },
        {
          name: "Merge overlapping passages",
          desc: "On a full-note read, consecutive windows of one section are joined and the ~150 characters each carries from the previous window are sent once. Leaves the text agreeing with the line ranges shown.",
          control: { type: "toggle", key: "contextSavings.mergeOverlappingPassages" },
        },
      ],
    },
    {
      type: "group",
      heading: "Advanced",
      items: [
        {
          name: "Debug logging",
          desc: "Log activity to the developer console. Secrets are always redacted.",
          control: { type: "toggle", key: "debugLogging" },
        },
      ],
    },
  ];
}
