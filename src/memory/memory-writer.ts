/**
 * memory-writer — the ONLY component that writes memory into the vault.
 *
 * Safety model:
 *   - `proposeToInbox` is the default and is always available. It APPENDS a
 *     reviewable entry to `<root>/Memory/Inbox/pending-memory.md`.
 *   - `directWrite` writes to a target memory file and is DOUBLE-GATED: it
 *     throws unless `allowDirectWrites` is enabled, and it refuses any target
 *     outside the memory root. When `appendOnly` is set it only ever appends.
 *
 * No method here can write outside the memory root — every target is validated
 * against it.
 */

import { VaultAdapter } from "../core/vault-adapter";
import { MemoryEntry, MemoryPaths } from "./memory-types";
import { isInsideRoot, resolveInVault } from "../utils/paths";
import { ConfigError, PathSecurityError } from "../utils/errors";
import { Logger, NULL_LOGGER } from "../utils/logger";

export interface MemoryWriterOptions {
  appendOnly: boolean;
  allowDirectWrites: boolean;
  logger?: Logger;
}

/** Format a ms-epoch timestamp as "YYYY-MM-DD HH:MM" in local time. */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function formatTags(tags: string[]): string {
  const base = ["#claude-code-engram"];
  const extra = tags
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean)
    .map((t) => `#${t}`);
  return Array.from(new Set([...base, ...extra])).join(" ");
}

/** Render a MemoryEntry as a reviewable Markdown block. */
export function formatMemoryEntry(entry: MemoryEntry): string {
  const lines: string[] = [];
  lines.push(`## Pending Memory: ${formatTimestamp(entry.timestamp)}`);
  lines.push("");
  lines.push(`Type: ${entry.type}`);
  if (entry.project) lines.push(`Project: ${entry.project}`);
  lines.push(`Source: ${entry.source}`);
  if (entry.originTool) lines.push(`Origin: ${entry.originTool}`);
  if (entry.confidence) lines.push(`Confidence: ${entry.confidence}`);
  lines.push(`Tags: ${formatTags(entry.tags)}`);
  lines.push("");
  lines.push("Content:");
  lines.push("");
  lines.push(entry.content.trim());
  if (entry.relatedPaths.length > 0) {
    lines.push("");
    lines.push("Related files:");
    lines.push("");
    for (const p of entry.relatedPaths) lines.push(`* ${p}`);
  }
  lines.push("");
  lines.push("Status: pending");
  lines.push("");
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

export class MemoryWriter {
  private readonly logger: Logger;

  constructor(
    private readonly adapter: VaultAdapter,
    private readonly paths: MemoryPaths,
    private readonly options: MemoryWriterOptions,
  ) {
    this.logger = options.logger ?? NULL_LOGGER;
  }

  /**
   * Append a reviewable entry to the pending-memory inbox. Always available;
   * this is the safe default for both UI and server writes.
   * @returns the pending-memory file path.
   */
  async proposeToInbox(entry: MemoryEntry): Promise<string> {
    const block = formatMemoryEntry(entry);
    const target = this.paths.pendingMemoryFile;
    // Defense-in-depth: the inbox file must live under the memory root.
    if (!isInsideRoot(this.paths.root, target)) {
      throw new PathSecurityError("Inbox path escapes the memory root");
    }
    const exists = await this.adapter.exists(target);
    if (!exists) {
      const header = "# Pending Memory Inbox\n\nReviewable memory proposed by Claude Code Engram. Apply or discard entries as you see fit.\n\n---\n\n";
      await this.adapter.write(target, header + block);
    } else {
      await this.adapter.append(target, block);
    }
    this.logger.info("Proposed memory to inbox", { type: entry.type, project: entry.project });
    return target;
  }

  /**
   * Direct write to a memory file. DOUBLE-GATED: requires `allowDirectWrites`
   * and a target inside the memory root. Honors append-only mode.
   * @param subpath vault-relative path UNDER the memory root.
   */
  async directWrite(subpath: string, entry: MemoryEntry): Promise<string> {
    if (!this.options.allowDirectWrites) {
      throw new ConfigError(
        "Direct memory writes are disabled. Enable 'Allow direct memory writes' in settings, or use the inbox.",
      );
    }
    const target = resolveInVault(this.paths.root, subpath);
    if (!isInsideRoot(this.paths.root, target)) {
      throw new PathSecurityError(`Direct write target escapes the memory root: "${subpath}"`);
    }
    const block = formatMemoryEntry(entry);
    if (this.options.appendOnly) {
      await this.adapter.append(target, `\n${block}`);
    } else if (await this.adapter.exists(target)) {
      const current = await this.adapter.read(target);
      await this.adapter.write(target, `${current}\n${block}`);
    } else {
      await this.adapter.write(target, block);
    }
    this.logger.info("Direct memory write", { target, type: entry.type });
    return target;
  }
}
