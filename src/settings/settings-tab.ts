/**
 * settings-tab — the plugin settings UI.
 *
 * Communicates the safe defaults (memory lives inside the vault; server off;
 * writes go to the review inbox) and validates the memory root so it can never
 * be set to a path that escapes the vault. The server section carries an
 * explicit security warning.
 */

import { App, Plugin, PluginSettingTab, Setting, Notice } from "obsidian";
import { EngramSettings, parseList } from "./settings";
import { normalizeVaultRelativePath } from "../utils/paths";

export interface SettingsHost {
  settings: EngramSettings;
  saveSettings(): Promise<void>;
  onSettingsChanged(): Promise<void> | void;
  rebuildIndex(): Promise<void>;
}

export class EngramSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly host: Plugin & SettingsHost,
  ) {
    super(app, host);
  }

  private get s(): EngramSettings {
    return this.host.settings;
  }

  private async commit(): Promise<void> {
    await this.host.saveSettings();
    await this.host.onSettingsChanged();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Claude Code Engram" });
    containerEl.createEl("p", {
      text: "All plugin-managed memory lives inside this vault, under the memory root below. Nothing is written outside the vault.",
      cls: "engram-stat-row",
    });

    this.section("Indexing");

    new Setting(containerEl)
      .setName("Enable indexing")
      .setDesc("Scan and index vault notes for retrieval.")
      .addToggle((t) =>
        t.setValue(this.s.indexingEnabled).onChange(async (v) => {
          this.s.indexingEnabled = v;
          await this.commit();
        }),
      );

    new Setting(containerEl)
      .setName("Memory root")
      .setDesc("Vault-relative folder for plugin-managed memory. Must stay inside the vault.")
      .addText((t) =>
        t
          .setPlaceholder("Claude Code")
          .setValue(this.s.memoryRoot)
          .onChange(async (v) => {
            const value = v.trim();
            try {
              const normalized = normalizeVaultRelativePath(value || "Claude Code");
              this.s.memoryRoot = normalized;
              await this.commit();
            } catch {
              new Notice("Invalid memory root: must be a relative path inside the vault.");
            }
          }),
      );

    new Setting(containerEl)
      .setName("Included folders")
      .setDesc("Allowlist (one per line or comma-separated). Empty = whole vault.")
      .addTextArea((t) =>
        t.setValue(this.s.includedFolders.join("\n")).onChange(async (v) => {
          this.s.includedFolders = parseList(v);
          await this.commit();
        }),
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Denylist of folders to skip.")
      .addTextArea((t) =>
        t.setValue(this.s.excludedFolders.join("\n")).onChange(async (v) => {
          this.s.excludedFolders = parseList(v);
          await this.commit();
        }),
      );

    new Setting(containerEl)
      .setName("Excluded tags")
      .setDesc("Notes carrying any of these tags are never indexed.")
      .addTextArea((t) =>
        t.setValue(this.s.excludedTags.join("\n")).onChange(async (v) => {
          this.s.excludedTags = parseList(v);
          await this.commit();
        }),
      );

    new Setting(containerEl)
      .setName("Excluded path patterns")
      .setDesc("Glob (*, **) or substring patterns for sensitive notes to skip.")
      .addTextArea((t) =>
        t.setValue(this.s.excludedPathPatterns.join("\n")).onChange(async (v) => {
          this.s.excludedPathPatterns = parseList(v);
          await this.commit();
        }),
      );

    new Setting(containerEl)
      .setName("Auto-index on file change")
      .setDesc("Debounced refresh when notes change. Off by default.")
      .addToggle((t) =>
        t.setValue(this.s.autoIndexOnChange).onChange(async (v) => {
          this.s.autoIndexOnChange = v;
          await this.commit();
        }),
      );

    new Setting(containerEl)
      .setName("Default project")
      .setDesc("Used by project-context and add-to-project commands.")
      .addText((t) =>
        t.setValue(this.s.defaultProject).onChange(async (v) => {
          this.s.defaultProject = v.trim();
          await this.commit();
        }),
      );

    new Setting(containerEl)
      .setName("Rebuild index")
      .setDesc("Discard and rebuild the index from scratch.")
      .addButton((b) =>
        b.setButtonText("Rebuild now").onClick(async () => {
          new Notice("Rebuilding index…");
          try {
            await this.host.rebuildIndex();
            new Notice("Index rebuilt.");
          } catch (err) {
            new Notice(`Rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      );

    this.section("Retrieval & embeddings");

    new Setting(containerEl)
      .setName("Embedding provider")
      .setDesc(
        "Retrieval currently uses lexical BM25 regardless of this setting. Vector retrieval " +
          "(Ollama / OpenAI-compatible) arrives in Milestone 3; the choice is saved for then.",
      )
      .addDropdown((dd) => {
        dd.addOption("none", "None (lexical BM25) — active");
        dd.addOption("mock", "Mock (development)");
        dd.addOption("ollama", "Ollama (local) — M3");
        dd.addOption("openai-compatible", "OpenAI-compatible — M3");
        dd.setValue(this.s.embeddingProvider).onChange(async (v) => {
          this.s.embeddingProvider = v as EngramSettings["embeddingProvider"];
          await this.commit();
        });
      });

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc("Model name for the selected provider (if applicable).")
      .addText((t) =>
        t.setValue(this.s.embeddingModel).onChange(async (v) => {
          this.s.embeddingModel = v.trim();
          await this.commit();
        }),
      );

    this.renderServerSection();
    this.renderWriteSafetySection();

    this.section("Advanced");
    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Log activity to the developer console. Secrets are always redacted.")
      .addToggle((t) =>
        t.setValue(this.s.debugLogging).onChange(async (v) => {
          this.s.debugLogging = v;
          await this.commit();
        }),
      );
  }

  private renderServerSection(): void {
    const { containerEl } = this;
    this.section("Local server (Claude Code / MCP bridge)");

    const warning = containerEl.createDiv({ cls: "engram-security-warning" });
    warning.createEl("strong", { text: "Security notice. " });
    warning.appendText(
      "The local server lets external tools query and propose memory. Keep it bound to 127.0.0.1, " +
        "set a token, and only enable it while you need it. Never bind to a public interface.",
    );

    new Setting(containerEl)
      .setName("Enable local server")
      .setDesc("Disabled by default. Starts a localhost bridge for Claude Code.")
      .addToggle((t) =>
        t.setValue(this.s.server.enabled).onChange(async (v) => {
          this.s.server.enabled = v;
          await this.commit();
        }),
      );

    new Setting(containerEl)
      .setName("Host")
      .setDesc("Bind address. Leave as 127.0.0.1 unless you fully understand the risk.")
      .addText((t) =>
        t.setValue(this.s.server.host).onChange(async (v) => {
          const host = v.trim() || "127.0.0.1";
          if (host !== "127.0.0.1" && host !== "localhost") {
            new Notice("Warning: binding the server to a non-localhost address exposes memory to your network.");
          }
          this.s.server.host = host;
          await this.commit();
        }),
      );

    new Setting(containerEl)
      .setName("Allow non-localhost binding")
      .setDesc(
        "Off by default. Required (together with a token) before the server will bind to any " +
          "address other than localhost. Leave OFF unless you fully understand the risk.",
      )
      .addToggle((t) =>
        t.setValue(this.s.server.allowNonLocalhost).onChange(async (v) => {
          if (v) new Notice("Non-localhost binding allowed. The server can now expose memory to your network.");
          this.s.server.allowNonLocalhost = v;
          await this.commit();
        }),
      );

    new Setting(containerEl)
      .setName("Port")
      .addText((t) =>
        t.setValue(String(this.s.server.port)).onChange(async (v) => {
          const port = Number(v);
          if (Number.isInteger(port) && port >= 1 && port <= 65535) {
            this.s.server.port = port;
            await this.commit();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Token")
      .setDesc("Required auth token for server requests. Strongly recommended; mandatory for non-localhost.")
      .addText((t) => {
        t.setPlaceholder("(set a strong token)").setValue(this.s.server.token).onChange(async (v) => {
          this.s.server.token = v.trim();
          await this.commit();
        });
        t.inputEl.type = "password";
      })
      .addButton((b) =>
        b.setButtonText("Generate").onClick(async () => {
          this.s.server.token = generateToken();
          await this.commit();
          this.display(); // re-render to show the new token value
          new Notice("Generated a new server token.");
        }),
      );
  }

  private renderWriteSafetySection(): void {
    const { containerEl } = this;
    this.section("Memory write safety");

    new Setting(containerEl)
      .setName("Allow direct memory writes")
      .setDesc("When OFF (default), all writes go to the review inbox. When ON, tools may write memory files directly.")
      .addToggle((t) =>
        t.setValue(this.s.allowDirectWrites).onChange(async (v) => {
          if (v) new Notice("Direct writes enabled. Memory files can now be modified without review.");
          this.s.allowDirectWrites = v;
          await this.commit();
        }),
      );

    new Setting(containerEl)
      .setName("Append-only writes")
      .setDesc("When ON (default), writes only append and never overwrite existing memory.")
      .addToggle((t) =>
        t.setValue(this.s.appendOnly).onChange(async (v) => {
          this.s.appendOnly = v;
          await this.commit();
        }),
      );
  }

  private section(title: string): void {
    this.containerEl.createEl("h3", { text: title, cls: "engram-setting-section-header" });
  }
}

/** Generate a 256-bit random token as hex, using the platform CSPRNG. */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
