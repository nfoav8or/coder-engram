/**
 * settings-tab — the plugin settings UI.
 *
 * Communicates the safe defaults (memory lives inside the vault; server off;
 * writes go to the review inbox) and validates the memory root so it can never
 * be set to a path that escapes the vault. The server section carries an
 * explicit security warning.
 */

import { App, Plugin, PluginSettingTab, Setting, Notice } from "obsidian";
import { toMessage } from "../utils/errors";
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

  /** Set by text-field edits; flushed to a single commit on blur / tab close. */
  private dirty = false;
  /** Raw memory-root text, validated only at flush so half-typed roots never
   * reload the index (and the user isn't Noticed per keystroke). */
  private rawMemoryRoot: string | null = null;

  private async commit(): Promise<void> {
    await this.host.saveSettings();
    await this.host.onSettingsChanged();
  }

  /**
   * Text fields update settings state per keystroke but COMMIT only when the
   * field loses focus (or the tab closes): a commit restarts subsystems —
   * server rebind, index reload from a half-typed memory root — so committing
   * on every input event turns typing into a restart storm.
   */
  private deferCommit(t: { inputEl: HTMLInputElement | HTMLTextAreaElement }): void {
    t.inputEl.addEventListener("blur", () => void this.flushCommit());
  }

  /**
   * A scan-list setting: one path/tag/pattern per line, parsed on input and
   * committed on blur like every other text field. The four of these differ
   * only in label and which key they write, so they share one builder.
   */
  private addListSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    key: "includedFolders" | "excludedFolders" | "excludedTags" | "excludedPathPatterns",
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addTextArea((t) => {
        t.setValue(this.s[key].join("\n")).onChange((v) => {
          this.s[key] = parseList(v);
          this.dirty = true;
        });
        this.deferCommit(t);
      });
  }

  private async flushCommit(): Promise<void> {
    if (this.rawMemoryRoot !== null) {
      const value = this.rawMemoryRoot.trim();
      this.rawMemoryRoot = null;
      try {
        this.s.memoryRoot = normalizeVaultRelativePath(value || "Claude Code");
      } catch {
        new Notice("Invalid memory root: must be a relative path inside the vault. Keeping the previous value.");
      }
    }
    if (!this.dirty) return;
    this.dirty = false;
    await this.commit();
  }

  hide(): void {
    void this.flushCommit();
    super.hide();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("p", {
      text: "All plugin-managed memory lives inside this vault, under the memory root below. Nothing is written outside the vault.",
      cls: "engram-stat-row",
    });

    this.renderIndexingSection();
    this.renderEmbeddingSection();
    this.renderServerSection();
    this.renderWriteSafetySection();
    this.renderAdvancedSection();
  }

  private renderIndexingSection(): void {
    const { containerEl } = this;
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
      .addText((t) => {
        t.setPlaceholder("Claude Code")
          .setValue(this.s.memoryRoot)
          .onChange((v) => {
            this.rawMemoryRoot = v;
            this.dirty = true;
          });
        this.deferCommit(t);
      });

    this.addListSetting(
      containerEl,
      "Included folders",
      "Allowlist (one per line or comma-separated). Empty = whole vault.",
      "includedFolders",
    );
    this.addListSetting(containerEl, "Excluded folders", "Denylist of folders to skip.", "excludedFolders");
    this.addListSetting(
      containerEl,
      "Excluded tags",
      "Notes carrying any of these tags are never indexed.",
      "excludedTags",
    );
    this.addListSetting(
      containerEl,
      "Excluded path patterns",
      "Glob (*, **) or substring patterns for sensitive notes to skip.",
      "excludedPathPatterns",
    );

    new Setting(containerEl)
      .setName("Index attachments")
      .setDesc(
        "Extract and index text from PDFs (via Obsidian's built-in PDF engine), " +
          "Office documents (docx/pptx/xlsx, odt/odp/ods, rtf), plain text " +
          "(txt/csv), and Canvas text cards. Fully local. Indexed attachment " +
          "text becomes searchable and readable over the local server, like " +
          "any note; exclusions apply to attachments too.",
      )
      .addToggle((t) =>
        t.setValue(this.s.indexAttachments).onChange(async (v) => {
          this.s.indexAttachments = v;
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
      .addText((t) => {
        t.setValue(this.s.defaultProject).onChange((v) => {
          this.s.defaultProject = v.trim();
          this.dirty = true;
        });
        this.deferCommit(t);
      });

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
            new Notice(`Rebuild failed: ${toMessage(err)}`);
          }
        }),
      );

  }

  private renderAdvancedSection(): void {
    const { containerEl } = this;

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

  private renderEmbeddingSection(): void {
    const { containerEl } = this;
    this.section("Retrieval & embeddings");

    new Setting(containerEl)
      .setName("Embedding provider")
      .setDesc(
        "None keeps retrieval fully offline (lexical BM25). Mock is deterministic hashing for " +
          "development. Ollama (local) and OpenAI-compatible enable vector + hybrid retrieval.",
      )
      .addDropdown((dd) => {
        dd.addOption("none", "None (lexical BM25)");
        dd.addOption("mock", "Mock (development)");
        dd.addOption("ollama", "Ollama (local)");
        dd.addOption("openai-compatible", "OpenAI-compatible");
        dd.setValue(this.s.embeddingProvider).onChange(async (v) => {
          if (v === "openai-compatible") {
            new Notice(
              "OpenAI-compatible sends your indexed note text to the configured endpoint. " +
                "Use a local endpoint or a provider you trust.",
            );
          }
          this.s.embeddingProvider = v as EngramSettings["embeddingProvider"];
          await this.commit();
          this.display(); // show/hide provider-specific fields
        });
      });

    new Setting(containerEl)
      .setName("Retrieval mode")
      .setDesc(
        "How results are ranked when a provider is set. Hybrid fuses lexical + vector (recommended); " +
          "Vector is embeddings-only; Lexical ignores embeddings. Always lexical when the provider is None.",
      )
      .addDropdown((dd) => {
        dd.addOption("hybrid", "Hybrid (lexical + vector)");
        dd.addOption("vector", "Vector only");
        dd.addOption("lexical", "Lexical only");
        dd.setValue(this.s.retrievalMode).onChange(async (v) => {
          this.s.retrievalMode = v as EngramSettings["retrievalMode"];
          await this.commit();
        });
      });

    const provider = this.s.embeddingProvider;
    const needsEndpoint = provider === "ollama" || provider === "openai-compatible";

    if (needsEndpoint) {
      new Setting(containerEl)
        .setName("Embedding model")
        .setDesc(
          provider === "ollama"
            ? "Ollama model name, e.g. nomic-embed-text or mxbai-embed-large."
            : "Model name, e.g. text-embedding-3-small.",
        )
        .addText((t) => {
          t.setValue(this.s.embeddingModel).onChange((v) => {
            this.s.embeddingModel = v.trim();
            this.dirty = true;
          });
          this.deferCommit(t);
        });

      new Setting(containerEl)
        .setName("Endpoint")
        .setDesc(
          provider === "ollama"
            ? "Base URL of the Ollama server. Default http://127.0.0.1:11434."
            : "Base URL of the OpenAI-compatible API, including any version prefix (e.g. https://api.openai.com/v1).",
        )
        .addText((t) => {
          t.setPlaceholder(provider === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1")
            .setValue(this.s.embeddingEndpoint)
            .onChange((v) => {
              this.s.embeddingEndpoint = v.trim();
              this.dirty = true;
            });
          this.deferCommit(t);
        });
    }

    if (provider === "openai-compatible") {
      new Setting(containerEl)
        .setName("API key")
        .setDesc("Bearer token for the endpoint. Stored locally and never logged.")
        .addText((t) => {
          t.setPlaceholder("(required)").setValue(this.s.embeddingApiKey).onChange((v) => {
            this.s.embeddingApiKey = v.trim();
            this.dirty = true;
          });
          t.inputEl.type = "password";
          this.deferCommit(t);
        });
    }

    if (needsEndpoint) {
      new Setting(containerEl)
        .setName("Batch size")
        .setDesc("Chunks per embedding request (1–512). Lower this if the provider rejects large batches.")
        .addText((t) => {
          t.setValue(String(this.s.embeddingBatchSize)).onChange((v) => {
            const n = Math.trunc(Number(v));
            if (Number.isFinite(n) && n >= 1 && n <= 512) {
              this.s.embeddingBatchSize = n;
              this.dirty = true;
            }
          });
          this.deferCommit(t);
        });
    }
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
      .addText((t) => {
        t.setValue(this.s.server.host).onChange((v) => {
          const host = v.trim() || "127.0.0.1";
          if (host !== "127.0.0.1" && host !== "localhost") {
            new Notice("Warning: binding the server to a non-localhost address exposes memory to your network.");
          }
          this.s.server.host = host;
          this.dirty = true;
        });
        this.deferCommit(t);
      });

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
      .addText((t) => {
        t.setValue(String(this.s.server.port)).onChange((v) => {
          const port = Number(v);
          if (Number.isInteger(port) && port >= 1 && port <= 65535) {
            this.s.server.port = port;
            this.dirty = true;
          }
        });
        this.deferCommit(t);
      });

    new Setting(containerEl)
      .setName("Token")
      .setDesc("Required auth token for server requests. Strongly recommended; mandatory for non-localhost.")
      .addText((t) => {
        t.setPlaceholder("(set a strong token)").setValue(this.s.server.token).onChange((v) => {
          this.s.server.token = v.trim();
          this.dirty = true;
        });
        t.inputEl.type = "password";
        this.deferCommit(t);
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
    new Setting(this.containerEl).setName(title).setHeading();
  }
}

/** Generate a 256-bit random token as hex, using the platform CSPRNG. */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
