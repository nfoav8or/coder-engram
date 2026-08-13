import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSettingDefinitions,
  readSettingValue,
  writeSettingValue,
  DefinitionContext,
} from "../src/settings/setting-definitions";
import { DEFAULT_SETTINGS, EngramSettings } from "../src/settings/settings";

/**
 * The settings tab used to be ~500 lines of imperative UI no test could reach.
 * The declarative port makes it a value, so these are the assertions that were
 * impossible before: that every setting is actually wired, and to the right key.
 */
function context(overrides: Partial<EngramSettings> = {}): {
  ctx: DefinitionContext;
  settings: EngramSettings;
  notices: string[];
} {
  const settings: EngramSettings = structuredClone({ ...DEFAULT_SETTINGS, ...overrides });
  const notices: string[] = [];
  const ctx: DefinitionContext = {
    settings,
    notify: (m) => notices.push(m),
    rebuildIndex: () => Promise.resolve(),
    commit: () => {},
    generateToken: () => "generated-token",
    update: () => {},
  };
  return { ctx, settings, notices };
}

/** Every control-bearing definition, flattened out of its groups. */
function controls(ctx: DefinitionContext): Array<{ name: string; key: string; type: string }> {
  const out: Array<{ name: string; key: string; type: string }> = [];
  for (const item of buildSettingDefinitions(ctx)) {
    const children = "items" in item && item.items ? item.items : [item];
    for (const child of children) {
      if ("control" in child && child.control) {
        out.push({ name: child.name, key: child.control.key, type: child.control.type });
      }
    }
  }
  return out;
}

describe("setting definitions", () => {
  it("gives every persisted setting a control, or renders it deliberately", () => {
    // The failure this catches: a setting added to the model and to nothing
    // else, invisible in the UI and unfindable in settings search.
    const { ctx } = context();
    const keyed = new Set(controls(ctx).map((c) => c.key));
    // The two secrets are rendered rather than declared, because the
    // declarative text control has no masked variant.
    const rendered = new Set(["embeddingApiKey", "server.token"]);

    const missing: string[] = [];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (key === "schemaVersion") continue;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const nested of Object.keys(value as Record<string, unknown>)) {
          const dotted = `${key}.${nested}`;
          if (!keyed.has(dotted) && !rendered.has(dotted)) missing.push(dotted);
        }
        continue;
      }
      if (!keyed.has(key) && !rendered.has(key)) missing.push(key);
    }
    expect(missing).toEqual([]);
  });

  it("never binds two controls to the same key", () => {
    const { ctx } = context();
    const keys = controls(ctx).map((c) => c.key);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("reads and writes every control key against the settings object", () => {
    // A key that reads but does not write (or writes somewhere else) is the
    // classic declarative-port bug: the control shows a value and silently
    // discards the user's change.
    const { ctx, settings } = context();
    for (const control of controls(ctx)) {
      const before = readSettingValue(settings, control.key);
      expect(before, `${control.key} is not readable`).not.toBeUndefined();

      const next =
        control.type === "toggle"
          ? !(before as boolean)
          : control.type === "number"
            ? (before as number) + 1
            : control.type === "dropdown"
              ? String(before)
              : "changed-value";
      writeSettingValue(settings, control.key, next);
      const after = readSettingValue(settings, control.key);
      if (control.type === "textarea") {
        // List keys store lines as an array; the control speaks text.
        expect(after, `${control.key} did not round-trip`).toBe("changed-value");
      } else {
        expect(after, `${control.key} did not round-trip`).toBe(next);
      }
    }
  });

  it("stores a list setting as lines and reads it back as text", () => {
    const { settings } = context();
    writeSettingValue(settings, "excludedFolders", "Private\nWork/Secret\n\n");
    expect(settings.excludedFolders).toEqual(["Private", "Work/Secret"]);
    expect(readSettingValue(settings, "excludedFolders")).toBe("Private\nWork/Secret");
  });

  it("normalizes the memory root it stores and refuses one that escapes the vault", () => {
    const { ctx, settings } = context();
    const root = controls(ctx).find((c) => c.key === "memoryRoot");
    expect(root).toBeDefined();

    const definition = buildSettingDefinitions(ctx)
      .flatMap((item) => ("items" in item && item.items ? item.items : [item]))
      .find((d) => "control" in d && d.control?.key === "memoryRoot");
    const validate = (definition as { control: { validate: (v: string) => string | undefined } }).control
      .validate;

    expect(validate("Notes/Memory")).toBeUndefined();
    expect(validate("")).toBeUndefined();
    expect(validate("../escape")).toContain("inside the vault");

    writeSettingValue(settings, "memoryRoot", "  ./Notes/Memory/  ");
    expect(settings.memoryRoot).toBe("Notes/Memory");
    writeSettingValue(settings, "memoryRoot", "   ");
    expect(settings.memoryRoot).toBe("Claude Code");
  });

  it("refuses a port or batch size outside its range", () => {
    // The imperative tab guarded both fields by ignoring bad input. On the
    // declarative path `min`/`max` are hints to the input element, not a bound
    // the framework enforces, so without `validate` a nonsense port reaches
    // settings — the server then refuses to start, and the next reload
    // silently rewrites the value to the clamp.
    const { ctx } = context();
    const validatorFor = (key: string) => {
      const found = buildSettingDefinitions(ctx)
        .flatMap((item) => ("items" in item && item.items ? item.items : [item]))
        .find((d) => "control" in d && d.control?.key === key);
      return (found as { control: { validate?: (v: number) => string | undefined } }).control.validate;
    };

    const port = validatorFor("server.port");
    expect(port, "port has no validator").toBeDefined();
    expect(port!(3999)).toBeUndefined();
    expect(port!(1)).toBeUndefined();
    expect(port!(65535)).toBeUndefined();
    expect(port!(0)).toContain("1 to 65535");
    expect(port!(65536)).toContain("1 to 65535");
    expect(port!(-5)).toContain("1 to 65535");
    expect(port!(80.5)).toContain("whole number");

    const batch = validatorFor("embeddingBatchSize");
    expect(batch, "batch size has no validator").toBeDefined();
    expect(batch!(16)).toBeUndefined();
    expect(batch!(0)).toContain("1 to 512");
    expect(batch!(513)).toContain("1 to 512");
  });

  it("trims a token and an endpoint rather than storing stray whitespace", () => {
    const { settings } = context();
    writeSettingValue(settings, "server.token", "  secret-token  ");
    expect(settings.server.token).toBe("secret-token");
    writeSettingValue(settings, "embeddingEndpoint", " http://127.0.0.1:11434 ");
    expect(settings.embeddingEndpoint).toBe("http://127.0.0.1:11434");
  });

  it("shows provider-specific rows only for the provider that needs them", () => {
    const visibilityOf = (settings: Partial<EngramSettings>, name: string): boolean => {
      const { ctx } = context(settings);
      const found = buildSettingDefinitions(ctx)
        .flatMap((item) => ("items" in item && item.items ? item.items : [item]))
        .find((d) => "name" in d && d.name === name);
      const visible = (found as { visible?: boolean | (() => boolean) } | undefined)?.visible;
      if (visible === undefined) return true;
      return typeof visible === "function" ? visible() : visible;
    };

    expect(visibilityOf({ embeddingProvider: "none" }, "Endpoint")).toBe(false);
    expect(visibilityOf({ embeddingProvider: "none" }, "API key")).toBe(false);
    expect(visibilityOf({ embeddingProvider: "ollama" }, "Endpoint")).toBe(true);
    expect(visibilityOf({ embeddingProvider: "ollama" }, "Batch size")).toBe(true);
    // The key is the one field that must never show for a local provider.
    expect(visibilityOf({ embeddingProvider: "ollama" }, "API key")).toBe(false);
    expect(visibilityOf({ embeddingProvider: "openai-compatible" }, "API key")).toBe(true);
  });

  it("describes the endpoint for the provider actually selected", () => {
    const descOf = (provider: EngramSettings["embeddingProvider"]): string => {
      const { ctx } = context({ embeddingProvider: provider });
      const found = buildSettingDefinitions(ctx)
        .flatMap((item) => ("items" in item && item.items ? item.items : [item]))
        .find((d) => "name" in d && d.name === "Endpoint");
      return String((found as { desc?: string }).desc);
    };
    expect(descOf("ollama")).toContain("Ollama");
    expect(descOf("openai-compatible")).toContain("OpenAI-compatible");
  });

  it("disables image text until attachment indexing is on", () => {
    const disabledWhen = (indexAttachments: boolean): boolean => {
      const { ctx } = context({ indexAttachments });
      const found = buildSettingDefinitions(ctx)
        .flatMap((item) => ("items" in item && item.items ? item.items : [item]))
        .find((d) => "control" in d && d.control?.key === "indexImageText");
      const disabled = (found as { control: { disabled?: boolean | (() => boolean) } }).control.disabled;
      return typeof disabled === "function" ? disabled() : Boolean(disabled);
    };
    expect(disabledWhen(false)).toBe(true);
    expect(disabledWhen(true)).toBe(false);
  });

  it("offers the same settings as the imperative tab it ships alongside", () => {
    // Two settings UIs ship: `display()` for apps below 1.13 and these
    // definitions for 1.13+. Obsidian picks one, so a setting added to only
    // one of them is invisible to half the users and nothing else would catch
    // it — the imperative tab cannot be imported here (it extends a runtime
    // Obsidian class), so this compares its source.
    const tabSource = readFileSync(
      join(__dirname, "..", "src", "settings", "settings-tab.ts"),
      "utf8",
    );
    const imperative = new Set(
      [
        ...tabSource.matchAll(/\.setName\("([^"]+)"\)/g),
        ...tabSource.matchAll(/add(?:List|Saving)Setting\(\s*containerEl,\s*"([^"]+)"/g),
      ].map((m) => m[1].toLowerCase()),
    );

    const { ctx } = context();
    // Section headings and the two informational rows have no counterpart:
    // the imperative tab writes those as plain paragraphs, not settings.
    const INFO_ROWS = new Set(["security notice", "about context savings"]);
    const declarative = buildSettingDefinitions(ctx)
      .flatMap((item) => ("items" in item && item.items ? item.items : [item]))
      .map((d) => ("name" in d ? d.name : ""))
      .filter(Boolean)
      .map((n) => n.toLowerCase())
      .filter((n) => !INFO_ROWS.has(n));

    const missingFromImperative = declarative.filter((n) => !imperative.has(n));
    expect(missingFromImperative, "settings only users on 1.13+ can reach").toEqual([]);
  });

  it("offers every provider and retrieval mode the settings model accepts", () => {
    // A dropdown that omits a valid option strands anyone already on it.
    const { ctx } = context();
    const defs = buildSettingDefinitions(ctx).flatMap((item) =>
      "items" in item && item.items ? item.items : [item],
    );
    const optionsFor = (key: string): string[] => {
      const found = defs.find((d) => "control" in d && d.control?.key === key);
      return Object.keys((found as { control: { options: Record<string, string> } }).control.options);
    };
    expect(optionsFor("embeddingProvider").sort()).toEqual(
      ["mock", "none", "ollama", "openai-compatible"].sort(),
    );
    expect(optionsFor("retrievalMode").sort()).toEqual(["hybrid", "lexical", "vector"].sort());
  });
});
