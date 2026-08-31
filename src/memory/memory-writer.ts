/**
 * memory-writer — the ONLY component that writes memory into the vault.
 *
 * Safety model:
 *   - `proposeToInbox` is the default and is always available. It APPENDS a
 *     reviewable entry to `<root>/Memory/Inbox/pending-memory.md`.
 *   - `discardPending` records what it removed in the rejection ledger
 *     (`<root>/Memory/Inbox/rejected-memory.md`) so the agent can see that a
 *     proposal was rejected rather than silently re-proposing it forever. The
 *     ledger is append-only and capped; clearing it is a deliberate UI action.
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
  PendingBlockFields,
  PendingEntry,
  REJECTED_HEADER,
  REJECTED_HEADING_PREFIX,
  formatAppliedBlock,
  parsePendingInbox,
  removeEntry,
  renderPendingBlock,
  resolveApplyDestination,
  serializePendingInbox,
} from "./pending-inbox";
import { isInsideRoot, resolveInVault } from "../utils/paths";
import { foldForCompare } from "../utils/text";
import { ConfigError, PathSecurityError, toMessage } from "../utils/errors";
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

/**
 * The dedup identity of a proposal: content (normalized by {@link contentKey}),
 * type, and project. Metadata that legitimately varies between otherwise
 * identical proposals (timestamp, source, tags) is intentionally ignored.
 *
 * One function so the O(1) cache below and a full re-scan cannot disagree
 * about what "the same memory" means — a cache keyed differently from the
 * comparison it replaces is how a dedup cache silently stops deduping.
 */
function dedupKey(content: string, type: string, project: string | undefined): string {
  // Folded with `foldForCompare`, which is case AND Unicode form — the same
  // rule every other project comparison in the codebase uses (retrieval
  // filters, the scanner's exclusions, `list_pending_memory`).
  //
  // NFC alone was not enough, and the gap defeated the dedup's purpose: an
  // agent proposing the same fact under "engram" after "Engram" produced a
  // second inbox entry, because the content folded to one key and the project
  // did not. Case-variant project names are the norm, not the exception —
  // agents derive them from working-directory paths, users type them.
  return JSON.stringify([contentKey(content), type, foldForCompare(project ?? "")]);
}

function entryKey(entry: MemoryEntry): string {
  return dedupKey(entry.content, entry.type, entry.project);
}

function pendingKey(existing: PendingEntry): string {
  return dedupKey(existing.content, existing.type, existing.project);
}

/**
 * Records kept in the rejection ledger. The ledger exists so an agent stops
 * re-proposing what a reviewer already turned down, which needs only the recent
 * past — an unbounded ledger would grow with every discard and be read on every
 * proposal. Oldest records fall off; deleting one simply lets that memory be
 * proposed again, which is the documented way to undo a rejection.
 */
export const REJECTION_LOG_MAX = 200;

/**
 * Index ledger records by dedup key. Later records win: a memory rejected twice
 * reports the most recent reason, which is the one the reviewer last gave.
 */
function rejectionKeysOf(entries: PendingBlockFields[]): Map<string, RejectionMatch> {
  const keys = new Map<string, RejectionMatch>();
  for (const e of entries) {
    keys.set(dedupKey(e.content, e.type, e.project), {
      reason: e.reason,
      timestampLabel: e.timestampLabel,
    });
  }
  return keys;
}

/** What the ledger remembers about a rejected proposal. */
export interface RejectionMatch {
  /** The reviewer's stated reason, when they gave one. */
  reason?: string;
  /** The rejected proposal's original timestamp label. */
  timestampLabel: string;
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
  /**
   * Dedup keys of the inbox as of `mtime`. Invalidated two ways: this class
   * clears it outright whenever IT rewrites the inbox (apply/discard), and the
   * mtime check in {@link proposeToInbox} catches every other writer. The
   * mtime alone is not enough — it can repeat when two writes land in the same
   * tick or the filesystem's resolution is coarse, and a stale hit would
   * report a genuinely new memory as a duplicate and silently drop it.
   */
  private dedupCache: { mtime: number; keys: Set<string> } | null = null;
  /**
   * Rejection keys as of the ledger's `mtime`, invalidated the same two ways as
   * {@link dedupCache}: cleared outright whenever this class rewrites the
   * ledger, and mtime-checked against every other writer (a user deleting a
   * record in Obsidian to un-reject a memory is the expected case, and it must
   * take effect on the next proposal).
   */
  private rejectionCache: { mtime: number; keys: Map<string, RejectionMatch> } | null = null;

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
  async proposeToInbox(
    entry: MemoryEntry,
    opts: { reviewerAuthored?: boolean } = {},
  ): Promise<{ path: string; duplicate: boolean; rejection: RejectionMatch | null }> {
    const block = formatMemoryEntry(entry);
    const target = this.paths.pendingMemoryFile;
    // Defense-in-depth: the inbox file must live under the memory root.
    if (!isInsideRoot(this.paths.root, target)) {
      throw new PathSecurityError("Inbox path escapes the memory root");
    }
    return this.inboxLock.run(async () => {
      // Rejection is checked BEFORE the inbox is touched: a proposal a reviewer
      // already turned down must not reappear in their inbox, and reporting it
      // as "rejected" rather than "added" is the whole point of the ledger.
      // Deliberately an EXACT key match, the same identity the dedup uses — a
      // proposal that rephrases or adds detail is a different memory and gets
      // through, so rejecting one fact cannot silently swallow a later, better
      // one.
      // A reviewer typing the memory themselves overrides their own earlier
      // rejection — that is the same person changing their mind, and silently
      // dropping what they just typed would be indefensible. The stale record
      // is dropped with it, so it cannot go on suppressing the agent for a
      // memory its owner has now asked for.
      const rejection = (await this.rejectionKeys()).get(entryKey(entry)) ?? null;
      if (rejection && opts.reviewerAuthored) {
        await this.unreject(entryKey(entry));
      } else if (rejection) {
        this.logger.info("Skipped previously-rejected memory proposal", {
          type: entry.type,
          project: entry.project,
        });
        return { path: this.paths.rejectedMemoryFile, duplicate: false, rejection };
      }

      // Creation is still gated on exists(), deliberately not on a null mtime:
      // they are separate Obsidian calls, and if they ever disagreed, treating
      // "no mtime" as "no file" would overwrite an inbox full of unreviewed
      // memory. The mtime below is only ever a cache key.
      if (!(await this.adapter.exists(target))) {
        await this.adapter.write(target, INBOX_HEADER + block);
        // The file's whole contents are known here — one entry — so seed the
        // cache rather than forcing the next call to parse what we just wrote.
        const created = await this.adapter.getMtime(target);
        this.dedupCache =
          created === null ? null : { mtime: created, keys: new Set([entryKey(entry)]) };
        this.logger.info("Proposed memory to inbox", { type: entry.type, project: entry.project });
        return { path: target, duplicate: false, rejection: null };
      }

      // Reading and re-parsing the whole inbox on every call is O(inbox), and
      // the backlog grows with agent usage rather than vault size — an inbox
      // left unreviewed makes every later add_memory slower. The parsed dedup
      // keys are cached against the file's mtime instead.
      //
      // Two layers of invalidation, because neither alone is enough. The
      // plugin's own rewrites (apply/discard) clear the cache outright, since
      // an mtime can repeat when two writes land in the same tick or the
      // filesystem's resolution is coarse. Everything else — a user editing
      // the inbox in Obsidian, another tool touching the file — is caught by
      // the mtime check here. A null mtime simply means no cache hit.
      const mtime = await this.adapter.getMtime(target);
      let keys = mtime !== null && this.dedupCache?.mtime === mtime ? this.dedupCache.keys : null;
      if (!keys) {
        const parsed = parsePendingInbox(await this.adapter.read(target));
        keys = new Set(parsed.entries.map(pendingKey));
      }

      if (keys.has(entryKey(entry))) {
        this.dedupCache = mtime === null ? null : { mtime, keys };
        this.logger.info("Skipped duplicate memory proposal", { type: entry.type, project: entry.project });
        return { path: target, duplicate: true, rejection: null };
      }
      await this.adapter.append(target, block);
      // Keep the cache warm across consecutive proposals: record our own new
      // key and the mtime the append produced, so a run of add_memory calls
      // costs one parse in total rather than one per call.
      keys.add(entryKey(entry));
      const after = await this.adapter.getMtime(target);
      this.dedupCache = after === null ? null : { mtime: after, keys };
      this.logger.info("Proposed memory to inbox", { type: entry.type, project: entry.project });
      return { path: target, duplicate: false, rejection: null };
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
      // This method rewrites the inbox, so the dedup cache is invalid from
      // here on. Cleared explicitly rather than relying on the mtime moving:
      // mtime resolution is coarse on some filesystems, and an apply followed
      // immediately by a propose can land in the same tick — in which case a
      // stale cache would report a genuinely new memory as a duplicate and
      // silently drop it.
      this.dedupCache = null;
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

  /**
   * Remove a reviewed entry from the inbox and record the rejection.
   *
   * The removal is the contract; the ledger record is best-effort ON PURPOSE.
   * The inbox is written first so a ledger failure cannot leave a record
   * claiming a still-pending entry was rejected (which would then suppress the
   * agent's proposals for a memory nobody has ruled on). A failed record loses
   * only the feedback, is reported to the caller, and never fails the discard
   * the user asked for.
   *
   * @returns recorded — whether the rejection reached the ledger.
   */
  async discardPending(
    entry: PendingEntry,
    opts: { reason?: string } = {},
  ): Promise<{ recorded: boolean }> {
    return this.inboxLock.run(async () => {
      const target = this.paths.pendingMemoryFile;
      // See applyPending: the cache cannot outlive a rewrite of the inbox.
      this.dedupCache = null;
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
      let recorded = false;
      try {
        await this.recordRejection(entry, opts.reason);
        recorded = true;
      } catch (err) {
        this.logger.warn("Discarded, but could not record the rejection", {
          error: toMessage(err),
        });
      }
      return { recorded };
    });
  }

  /**
   * Read + parse the rejection ledger. Returns an empty parse (with the
   * standard header) when the file does not exist yet.
   */
  async readRejections(): Promise<ParsedInbox> {
    const target = this.paths.rejectedMemoryFile;
    if (!(await this.adapter.exists(target))) {
      return { header: REJECTED_HEADER, entries: [] };
    }
    return parsePendingInbox(await this.adapter.read(target), REJECTED_HEADING_PREFIX);
  }

  /**
   * Empty the rejection ledger, letting every recorded memory be proposed
   * again. UI-only and never exposed over the server: forgetting what a
   * reviewer rejected is the reviewer's call, not the agent's.
   */
  async clearRejections(): Promise<void> {
    await this.inboxLock.run(async () => {
      await this.adapter.write(this.paths.rejectedMemoryFile, REJECTED_HEADER);
      await this.seedRejections([]);
      this.logger.info("Cleared the rejection ledger");
    });
  }

  /**
   * Append one rejection record, pruning the oldest once the ledger is full.
   * Called from inside the inbox lock — the ledger is read-modify-written here
   * and read by {@link proposeToInbox}, so it needs the same serialization the
   * inbox does.
   */
  private async recordRejection(entry: PendingEntry, reason?: string): Promise<void> {
    const target = this.paths.rejectedMemoryFile;
    // Defense-in-depth, matching proposeToInbox: this path is derived, never
    // user-supplied, but it is still a write target.
    if (!isInsideRoot(this.paths.root, target)) {
      throw new PathSecurityError("Rejection ledger path escapes the memory root");
    }
    const block = renderPendingBlock(
      { ...entry, reason, status: "rejected" },
      REJECTED_HEADING_PREFIX,
    );
    const { header, entries } = await this.readRejections();
    if (entries.length === 0 && !(await this.adapter.exists(target))) {
      await this.adapter.write(target, REJECTED_HEADER + block);
    } else if (entries.length < REJECTION_LOG_MAX) {
      await this.adapter.append(target, block);
    } else {
      // Full: keep the newest REJECTION_LOG_MAX - 1 and add this one.
      const kept = entries.slice(entries.length - (REJECTION_LOG_MAX - 1));
      await this.adapter.write(target, serializePendingInbox(header, kept) + block);
    }
    // Seeded, not invalidated: this method runs on every discard, and the next
    // proposal would otherwise re-read and re-parse the ledger we just wrote.
    await this.seedRejections([...entries, { ...entry, reason }]);
  }

  /** Drop every ledger record matching `key`, un-rejecting that memory. */
  private async unreject(key: string): Promise<void> {
    const { header, entries } = await this.readRejections();
    const kept = entries.filter((e) => pendingKey(e) !== key);
    if (kept.length === entries.length) return;
    await this.adapter.write(
      this.paths.rejectedMemoryFile,
      serializePendingInbox(header, kept),
    );
    await this.seedRejections(kept);
    this.logger.info("Un-rejected a memory the reviewer re-proposed");
  }

  /** Rejection keys as of the ledger's current mtime; see {@link rejectionCache}. */
  private async rejectionKeys(): Promise<Map<string, RejectionMatch>> {
    // One probe, not an exists() and then a getMtime(): a null mtime means
    // there is nothing to read, and reading nothing means nothing is
    // suppressed. That is the direction this check must fail in — a lost
    // suppression costs a duplicate the reviewer dismisses, where a phantom
    // one would silently withhold a memory nobody ruled on.
    const mtime = await this.adapter.getMtime(this.paths.rejectedMemoryFile);
    if (mtime === null) {
      this.rejectionCache = null;
      return new Map();
    }
    if (this.rejectionCache?.mtime === mtime) return this.rejectionCache.keys;
    const { entries } = await this.readRejections();
    const keys = rejectionKeysOf(entries);
    this.rejectionCache = { mtime, keys };
    return keys;
  }

  /** Record the ledger state this class just wrote, so the next proposal does
   * not re-read and re-parse a file whose contents we already know. */
  private async seedRejections(entries: PendingBlockFields[]): Promise<void> {
    const mtime = await this.adapter.getMtime(this.paths.rejectedMemoryFile);
    this.rejectionCache = mtime === null ? null : { mtime, keys: rejectionKeysOf(entries) };
  }
}
