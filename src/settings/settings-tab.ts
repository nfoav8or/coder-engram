/**
 * settings-tab — the plugin settings UI.
 *
 * Since 0.12.0 this is a thin host adapter, not a renderer: `minAppVersion` is
 * 1.13.0, so Obsidian always builds the tab from `getSettingDefinitions()` and
 * the imperative `display()` path is gone. What remains is the plumbing the
 * declarative renderer calls into — reading and writing control values,
 * debouncing commits so a keystroke does not restart the index or rebind the
 * server, and raising the warnings that belong to a value changing rather than
 * to how it was entered.
 *
 * The rows themselves, including memory-root validation and the server security
 * notice, live in `setting-definitions.ts`.
 */

import { App, Plugin, PluginSettingTab, Notice, SettingDefinitionItem } from "obsidian";
import { EngramSettings } from "./settings";
import { debounce } from "../utils/debounce";
import { buildSettingDefinitions, readSettingValue, writeSettingValue } from "./setting-definitions";

export interface SettingsHost {
  settings: EngramSettings;
  saveSettings(): Promise<void>;
  onSettingsChanged(): Promise<void> | void;
  rebuildIndex(): Promise<void>;
}

/**
 * How long a change waits before the plugin acts on it. A commit restarts
 * subsystems — the server rebinds, the index reloads — and `setControlValue`
 * fires as the user types, so acting on every keystroke would turn typing into
 * a restart storm.
 */
const COMMIT_DELAY_MS = 400;

export class EngramSettingTab extends PluginSettingTab {
  /**
   * The same object as the `Plugin` handed to `super()`, held at its
   * `SettingsHost` type on purpose.
   *
   * Obsidian 1.13 gave `Plugin` a `settings` property of its own, so reading
   * `settings` off a `Plugin & SettingsHost` resolves to Obsidian's rather than
   * this plugin's. This plugin's settings come from this plugin, so they are
   * read through the interface that declares them. The collision is why this
   * matters even now that 1.13 is the minimum: the two properties would simply
   * be different objects, silently.
   */
  private readonly host: SettingsHost;

  constructor(app: App, plugin: Plugin & SettingsHost) {
    super(app, plugin);
    this.host = plugin;
  }

  private get s(): EngramSettings {
    return this.host.settings;
  }

  private async commit(): Promise<void> {
    await this.host.saveSettings();
    await this.host.onSettingsChanged();
  }

  // --- declarative settings ---------------------------------------------------
  //
  // The only rendering path as of 0.12.0. `minAppVersion` is 1.13.0, so
  // Obsidian always builds the tab from these definitions, and every setting
  // appears in settings search. The imperative `display()` that used to ship
  // alongside for older apps is gone; `versions.json` still maps every release
  // up to 0.11.4 to 1.7.2, so an app below 1.13 is offered 0.11.4 and keeps
  // working rather than being handed a tab it cannot render.

  /**
   * Commit debounce for the declarative path.
   *
   * `setControlValue` fires as the user edits a control, and a commit restarts
   * subsystems — the server rebinds, the index reloads. The old imperative tab
   * batches those with a blur listener, which the declarative API gives no hook
   * for, so the batching moves here: the value lands in settings immediately
   * (the control never fights the typing) and the expensive reaction waits.
   */
  private readonly commitSoon = debounce(() => {
    void this.commit();
  }, COMMIT_DELAY_MS);

  /**
   * The tab. Obsidian builds every row from what this returns, which is what
   * puts each setting in settings search.
   *
   * As of 0.12.0 `minAppVersion` is 1.13.0, so this API and the two below are
   * no longer newer than the declared floor and `no-unsupported-api` has
   * nothing to report about them.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return buildSettingDefinitions({
      settings: this.s,
      notify: (message) => {
        new Notice(message);
      },
      rebuildIndex: () => this.host.rebuildIndex(),
      commit: () => this.commitSoon(),
      generateToken,
      update: () => {
        this.updateDefinitions();
      },
    });
  }

  getControlValue(key: string): unknown {
    return readSettingValue(this.s, key);
  }

  setControlValue(key: string, value: unknown): void {
    writeSettingValue(this.s, key, value);
    this.warnAbout(key, value);
    this.commitSoon();
    // The provider decides which rows exist and what two of the descriptions
    // say, so the definitions themselves change — `update()`, not the cheap
    // `refreshDomState()` that only re-runs visible/disabled predicates.
    if (key === "embeddingProvider") this.updateDefinitions();
    else if (key === "indexAttachments") this.refreshDom();
  }

  /**
   * `update()` and `refreshDomState()` are guaranteed by the 1.13.0 floor, so
   * the optional call is no longer bridging an older app. It stays because the
   * alternative is a hard throw out of a settings keystroke if a future
   * Obsidian renames either one — and the cost of being wrong is asymmetric:
   * a row that fails to re-render is a visual glitch, an exception here breaks
   * editing settings at all.
   */
  private get newerApi(): { update?: () => void; refreshDomState?: () => void } {
    // Typed as possibly-absent so the call site above must go through `?.`.
    return this;
  }

  private updateDefinitions(): void {
    this.newerApi.update?.();
  }

  private refreshDom(): void {
    this.newerApi.refreshDomState?.();
  }

  /**
   * Warnings that belong to a value changing rather than to how it was
   * entered, so they live here rather than in any one control's renderer.
   */
  private warnAbout(key: string, value: unknown): void {
    if (key === "embeddingProvider" && value === "openai-compatible") {
      new Notice(
        "OpenAI-compatible sends your indexed note text to the configured endpoint. " +
          "Use a local endpoint or a provider you trust.",
      );
    } else if (key === "server.allowNonLocalhost" && value === true) {
      new Notice("Non-localhost binding allowed. The server can now expose memory to your network.");
    } else if (key === "allowDirectWrites" && value === true) {
      new Notice("Direct writes enabled. Memory files can now be modified without review.");
    } else if (key === "server.host" && typeof value === "string") {
      const host = value.trim();
      if (host !== "" && host !== "127.0.0.1" && host !== "localhost") {
        new Notice(
          "Warning: binding the server to a non-localhost address exposes memory to your network.",
        );
      }
    }
  }

  hide(): void {
    // The debounce is cancelled and the commit run immediately: a tab closed
    // mid-debounce would otherwise drop the last edit.
    this.commitSoon.cancel();
    void this.commit();
    super.hide();
  }

}

/** Generate a 256-bit random token as hex, using the platform CSPRNG. */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  // `window` rather than `globalThis`: Obsidian pops out views into separate
  // windows, and plugin guidance is to reach the active window's globals.
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
