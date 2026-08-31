/**
 * supersession — pure rules for retiring a memory that a later one replaces.
 *
 * Memory used to be write-once: dedup deliberately keeps a restatement that
 * adds detail, so contradictory entries accumulated and nothing could ever be
 * retired. A stale memory is worse than no memory, because it still reads as
 * settled knowledge.
 *
 * Superseding is **append-only**, which is what lets it coexist with the
 * apply-never-overwrites invariant. Nothing rewrites the original: a record is
 * appended to the supersession ledger, and retrieval and context assembly stop
 * returning the named section. The text stays on disk, so the decision is
 * auditable and reversible by deleting one ledger record.
 *
 * A reference is `<vault path>#<heading>` — the note path and the leaf heading
 * of the section to retire, both of which an agent already has from a search
 * result's label.
 */

import { scanMarkdownLines } from "../core/markdown-chunker";
import { isInsideRoot } from "../utils/paths";
import { foldForCompare } from "../utils/text";

/** A parsed, root-validated supersession target. */
export interface SupersedesRef {
  /** Vault-relative path of the memory file holding the retired section. */
  path: string;
  /** Leaf heading of the retired section, without its leading `#`s. */
  heading: string;
}

/**
 * Comparison key for a superseded section. Folded for case and Unicode form
 * like every other path/name comparison in this codebase, so a reference typed
 * with different capitalisation still matches the section it names.
 */
export function supersessionKey(path: string, heading: string): string {
  return `${foldForCompare(path)}#${foldForCompare(heading)}`;
}

/**
 * Parse and validate a `path#heading` reference against the memory root.
 *
 * Two rules, both load-bearing:
 *
 *   - **Inside the memory root only.** Superseding hides a section from search
 *     and from context assembly, so a reference that could name an arbitrary
 *     vault note would let an agent's proposal quietly retire the user's own
 *     writing. Memory is the only thing this mechanism may retire.
 *   - **A heading is required.** A bare path would retire a whole file in one
 *     click, and a reviewer approving "this replaces that decision" is not
 *     approving the loss of everything else in the file.
 *
 * Returns `null` for anything that fails either rule; callers surface that as a
 * validation error rather than silently proposing an inert reference.
 */
export function parseSupersedesRef(raw: string, memoryRoot: string): SupersedesRef | null {
  const trimmed = raw.trim();
  const hash = trimmed.indexOf("#");
  if (hash <= 0) return null;
  const path = trimmed.slice(0, hash).trim();
  // Search labels join a heading path with " › ". An agent pasting the whole
  // label back is naming the leaf section it saw, so take that rather than
  // failing on a shape the tool itself produced.
  const heading = trimmed
    .slice(hash + 1)
    .split("›")
    .pop()!
    .trim()
    .replace(/^#+\s*/, "");
  if (!path || !heading) return null;
  try {
    if (!isInsideRoot(memoryRoot, path)) return null;
  } catch {
    return null;
  }
  return { path, heading };
}

/**
 * How many sections of `text` carry a heading matching `heading` (folded).
 *
 * The count matters, not just presence. A section is addressed by its heading
 * TEXT, so two blocks that happen to share one are indistinguishable here —
 * and retiring "that decision" must never silently retire a second, unrelated
 * one. Callers refuse to act on anything but exactly 1.
 *
 * Heading detection is the chunker's, not a local copy: a scanner that toggled
 * its fence state on any fence-looking line desynchronized on an unmatched
 * marker and swallowed every remaining section of the file.
 */
export function countSections(text: string, heading: string): number {
  const want = foldForCompare(heading);
  let found = 0;
  scanMarkdownLines(text.split("\n"), (_i, _line, h) => {
    if (h && foldForCompare(h.text) === want) found++;
  });
  return found;
}

/**
 * Remove the sections named by `keys` from one memory file's text.
 *
 * Whole-file context reads (`get_project_context`, `get_global_context`) return
 * a file verbatim, so filtering search alone would leave a superseded memory
 * still being served through the other door — the agent would see the retired
 * text and the replacement side by side with nothing to tell them apart.
 *
 * A section runs from its `## ` heading to the next heading at the same or a
 * shallower level, which is exactly the shape `formatAppliedBlock` emits. What
 * is removed is replaced by a one-line marker rather than deleted silently: a
 * reader who wonders where a decision went should be able to see that it was
 * retired, not conclude it was never recorded.
 */
export function stripSupersededSections(
  text: string,
  path: string,
  keys: ReadonlySet<string>,
): { text: string; removed: number } {
  if (keys.size === 0) return { text, removed: 0 };
  const out: string[] = [];
  let removed = 0;
  // Level of the section currently being dropped, or 0 when not dropping.
  let droppingLevel = 0;
  scanMarkdownLines(text.split("\n"), (_i, line, heading) => {
    if (heading) {
      if (droppingLevel > 0 && heading.level <= droppingLevel) droppingLevel = 0;
      if (droppingLevel === 0 && keys.has(supersessionKey(path, heading.text))) {
        droppingLevel = heading.level;
        removed++;
        out.push(`${"#".repeat(heading.level)} ${heading.text} — superseded`);
        out.push("");
        out.push("_Retired by a later memory; see Memory/Inbox/superseded-memory.md._");
        out.push("");
        return;
      }
    }
    if (droppingLevel === 0) out.push(line);
  });
  return { text: out.join("\n"), removed };
}
