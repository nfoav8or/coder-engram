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
import {
  INBOX_HEADER,
  ParsedInbox,
  PendingEntry,
  formatAppliedBlock,
  parsePendingInbox,
  removeEntry,
  renderPendingBlock,
  resolveApplyDestination,
} from "./pending-inbox";
import { isInsideRoot, resolveInVault } from "../utils/paths";
import { ConfigError, PathSecurityError } from "../utils/errors";
import { Logger, NULL_LOGGER } from "../utils/logger";

export interface MemoryWriterOptions {
  appendOnly: boolean;
  allowDirectWrites: boolean;
  logger?: Logger;
  /**
   * Shared serializer for inbox read-modify-writes. Pass one that outlives any
   * single writer: the guarantee below is about the inbox FILE, so a lock that
   * a writer owns privately stops holding the moment the writer is replaced.
   */
  inboxLock?: InboxLock;
}

/**
 * Serializes every inbox read-modify-write (propose / apply / discard) so
 * overlapping calls — a double-clicked review button, or a server `add_memory`
 * landing mid-apply — cannot interleave their read and write and clobber each
 * other (a lost removal resurrects an entry; a duplicated graduation writes a
 * block twice).
 *
 * This is a separate object rather than a field on `MemoryWriter` because the
 * engine rebuilds its writer on every settings change, and a per-writer chain
 * starts empty: a discard already in flight was left unwaited-for, so the next
 * discard read the pre-discard file and wrote back a copy that still held the
 * entry the first one removed. Measured, not theorised — with the chain on the
 * writer, a settings commit landing between two discards resurrected an entry.
 */
export class InboxLock {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(op: () => Promise<T>): Promise<T> {
    const started = this.chain.then(op, op);
    // Swallow on the chain so one failed op doesn't reject the next; the caller
    // still observes this op's own outcome via `started`.
    this.chain = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  }
}

/**
 * Content key for inbox dedup: Unicode-normalized, case-folded, with runs of
 * whitespace collapsed.
 *
 * An agent re-proposing a fact across sessions rarely reproduces its own
 * wording byte-for-byte — it re-wraps a line, indents differently, or varies
 * capitalisation — and byte-equality treats each of those as a new memory, so
 * the inbox accumulates entries a reviewer has to recognise as the same fact.
 * Normalising only whitespace, case, and Unicode form keeps this an EXACT
 * comparison of the words themselves: two proposals collide here only when they
 * say the same thing, never merely a similar one. Fuzzy (token-overlap)
 * matching is deliberately not used — suppressing a proposal that carries
 * genuinely new detail loses information permanently, which is far worse than a
 * duplicate a human can dismiss in one click.
 *
 * NFC matters because the same accented text reaches this function in two
 * encodings depending on where it came from: a path or filename read on macOS
 * arrives decomposed, the same words typed or pasted elsewhere arrive composed.
 * They render identically, so a reviewer sees two cards that look the same and
 * cannot tell why both are there. Normalising form cannot suppress real detail
 * — the two encodings ARE the same characters — so it costs the guarantee above
 * nothing.
 */
function contentKey(content: string): string {
  return content.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Two proposals are the "same memory" for dedup when their content (normalized
 * by {@link contentKey}), type, and project match. Metadata that legitimately
 * varies between otherwise-identical proposals (timestamp, source, tags) is
 * intentionally ignored. */
function isSameMemory(existing: PendingEntry, entry: MemoryEntry): boolean {
  return (
    contentKey(existing.content) === contentKey(entry.content) &&
    existing.type === entry.type &&
    // Same reason as contentKey: the project name reaching an agent from a
    // macOS working-directory path is decomposed, the one a user types is not.
    (existing.project ?? "").normalize("NFC") === (entry.project ?? "").normalize("NFC")
  );
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

/**
 * Render a MemoryEntry as a reviewable Markdown block. Delegates to the shared
 * {@link renderPendingBlock} so the on-disk inbox format has a single producer
 * and stays in lock-step with the parser used by the review UI.
 */
export function formatMemoryEntry(entry: MemoryEntry): string {
  return renderPendingBlock({
    timestampLabel: formatTimestamp(entry.timestamp),
    type: entry.type,
    project: entry.project,
    source: entry.source,
    originTool: entry.originTool,
    confidence: entry.confidence,
    tags: entry.tags,
    content: entry.content,
    relatedPaths: entry.relatedPaths,
    status: "pending",
  });
}

export class MemoryWriter {
  private readonly logger: Logger;

  constructor(
    private readonly adapter: VaultAdapter,
    private readonly paths: MemoryPaths,
    private readonly options: MemoryWriterOptions,
  ) {
    this.logger = options.logger ?? NULL_LOGGER;
    this.inboxLock = options.inboxLock ?? new InboxLock();
  }

  /** See InboxLock: shared when the caller supplies one, private otherwise. */
  private readonly inboxLock: InboxLock;

  /**
   * Append a reviewable entry to the pending-memory inbox. Always available;
   * this is the safe default for both UI and server writes.
   *
   * De-duplicates: if an entry with the same content, type, and project is
   * already pending, it is NOT appended again (so a looping/re-running agent
   * calling add_memory can't flood the review inbox with identical proposals).
   * Content is compared after whitespace/case normalization, so a re-wrapped or
   * re-capitalized restatement of a pending fact collides with it.
   * The read-compare-append runs inside the inbox mutex so the check and the
   * append cannot interleave with a concurrent propose/apply/discard.
   *
   * @returns the pending-memory file path and whether the entry was a duplicate
   *   (already present, so nothing was appended).
   */
  async proposeToInbox(entry: MemoryEntry): Promise<{ path: string; duplicate: boolean }> {
    const block = formatMemoryEntry(entry);
    const target = this.paths.pendingMemoryFile;
    // Defense-in-depth: the inbox file must live under the memory root.
    if (!isInsideRoot(this.paths.root, target)) {
      throw new PathSecurityError("Inbox path escapes the memory root");
    }
    return this.inboxLock.run(async () => {
      if (!(await this.adapter.exists(target))) {
        await this.adapter.write(target, INBOX_HEADER + block);
        this.logger.info("Proposed memory to inbox", { type: entry.type, project: entry.project });
        return { path: target, duplicate: false };
      }
      const existing = parsePendingInbox(await this.adapter.read(target));
      if (existing.entries.some((e) => isSameMemory(e, entry))) {
        this.logger.info("Skipped duplicate memory proposal", { type: entry.type, project: entry.project });
        return { path: target, duplicate: true };
      }
      await this.adapter.append(target, block);
      this.logger.info("Proposed memory to inbox", { type: entry.type, project: entry.project });
      return { path: target, duplicate: false };
    });
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

  /**
   * Read + parse the review inbox. Returns an empty parse (with the standard
   * header) when the inbox file does not exist yet.
   */
  async readInbox(): Promise<ParsedInbox> {
    const target = this.paths.pendingMemoryFile;
    if (!(await this.adapter.exists(target))) {
      return { header: INBOX_HEADER, entries: [] };
    }
    const text = await this.adapter.read(target);
    return parsePendingInbox(text);
  }

  /**
   * Graduate a reviewed inbox entry into its destination memory file, then drop
   * it from the inbox.
   *
   * This is the human-in-the-loop counterpart to {@link proposeToInbox}: the
   * inbox exists so a person reviews proposed memory before it lands, so this
   * promotion is intentionally NOT gated behind `allowDirectWrites` (which
   * governs unattended/tool direct writes). It is reachable only from the
   * desktop review UI — the local server never exposes it. It is still
   * constrained: the destination is validated inside the memory root and the
   * write is ALWAYS an append (it never overwrites an existing memory file),
   * regardless of the `appendOnly` setting.
   */
  async applyPending(entry: PendingEntry): Promise<{ destination: string }> {
    const destination = resolveApplyDestination(entry, this.paths);
    // Defense-in-depth: resolveApplyDestination already builds paths via
    // resolveInVault, but never write anywhere that isn't under the root.
    if (!isInsideRoot(this.paths.root, destination)) {
      throw new PathSecurityError("Apply destination escapes the memory root");
    }
    return this.inboxLock.run(async () => {
      const target = this.paths.pendingMemoryFile;
      if (!(await this.adapter.exists(target))) {
        throw new ConfigError("The pending-memory inbox no longer exists.");
      }
      // Compute the inbox-without-this-entry FIRST and bail if the entry is
      // already gone, so a retry of an apply that fully succeeded cannot append
      // a second graduated block.
      const text = await this.adapter.read(target);
      const next = removeEntry(text, entry);
      if (next === null) {
        throw new ConfigError(
          "That entry is no longer in the inbox (it may have been applied or removed elsewhere). Refresh and try again.",
        );
      }
      // Destination first, inbox second, and not the other way round: if either
      // write fails the entry must still exist somewhere. Clearing the inbox
      // first would lose the memory outright when the destination write fails,
      // where this order costs at worst a duplicate block on a manual retry.
      const block = formatAppliedBlock(entry);
      if (await this.adapter.exists(destination)) {
        await this.adapter.append(destination, `\n${block}`);
      } else {
        await this.adapter.write(destination, block);
      }
      await this.adapter.write(target, next);
      this.logger.info("Applied pending memory", { destination, type: entry.type });
      return { destination };
    });
  }

  /** Remove a reviewed entry from the inbox without writing it anywhere. */
  async discardPending(entry: PendingEntry): Promise<void> {
    await this.inboxLock.run(async () => {
      const target = this.paths.pendingMemoryFile;
      if (!(await this.adapter.exists(target))) {
        throw new ConfigError("The pending-memory inbox no longer exists.");
      }
      const text = await this.adapter.read(target);
      const next = removeEntry(text, entry);
      if (next === null) {
        throw new ConfigError(
          "That entry is no longer in the inbox (it may have been edited or removed elsewhere). Refresh and try again.",
        );
      }
      await this.adapter.write(target, next);
      this.logger.info("Discarded pending memory", { type: entry.type });
    });
  }
}
