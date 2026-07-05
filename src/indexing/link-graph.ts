/**
 * link-graph — derive note-to-note relationships from the index.
 *
 * Each `IndexedChunk` carries the outbound link targets found in its note
 * (`[[wikilinks]]` and relative Markdown links, harvested by the metadata
 * extractor). This resolves those targets back to INDEXED notes so callers can
 * navigate the memory graph: which indexed notes a note links to, and which
 * indexed notes link to it.
 *
 * Resolution is by basename (case-insensitive, `.md`/anchor/alias stripped) —
 * the form Obsidian wikilinks use. It is deliberately a heuristic: a target that
 * matches several notes' basenames resolves to all of them, and a target with no
 * indexed match (e.g. a link to an excluded or non-existent note) is dropped. So
 * only indexed notes ever appear — excluded/sensitive notes never leak in.
 */

import { IndexedChunk } from "./index-manager";

/** Basename of a path/target, without a `.md` extension, lowercased. This is the
 * key an Obsidian-style link resolves by. Anchors (`#…`) and aliases (`|…`) are
 * stripped first so `[[Note#Heading]]` and `note.md#h` both key on "note". */
export function linkKey(target: string): string {
  const noAnchor = target.split(/[#|]/)[0];
  const base = noAnchor.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  return base.replace(/\.md$/i, "").trim().toLowerCase();
}

export interface RelatedNotes {
  /** Indexed notes this note links TO (via its outbound links). */
  linksTo: string[];
  /** Indexed notes that link TO this note (backlinks). */
  linkedFrom: string[];
}

/**
 * Resolve the link graph over `chunks` and return the notes related to
 * `notePath`. `notePath` must be an indexed note's exact path; the caller is
 * responsible for the indexed-only gate. Results are sorted and never include
 * `notePath` itself.
 */
export function relatedNotes(notePath: string, chunks: IndexedChunk[]): RelatedNotes {
  const targetKey = linkKey(notePath);

  // notePath -> its distinct outbound link targets (raw), collected across chunks.
  const outByNote = new Map<string, Set<string>>();
  // basename key -> indexed note paths carrying that basename (collisions kept).
  const byKey = new Map<string, Set<string>>();

  for (const c of chunks) {
    let keySet = byKey.get(linkKey(c.notePath));
    if (!keySet) byKey.set(linkKey(c.notePath), (keySet = new Set()));
    keySet.add(c.notePath);

    let outs = outByNote.get(c.notePath);
    if (!outs) outByNote.set(c.notePath, (outs = new Set()));
    for (const l of c.links) outs.add(l);
  }

  const linksTo = new Set<string>();
  const linkedFrom = new Set<string>();
  for (const [note, outs] of outByNote) {
    for (const t of outs) {
      const k = linkKey(t);
      if (note === notePath) {
        for (const p of byKey.get(k) ?? []) if (p !== notePath) linksTo.add(p);
      }
      if (k === targetKey && note !== notePath) linkedFrom.add(note);
    }
  }

  return {
    linksTo: [...linksTo].sort(),
    linkedFrom: [...linkedFrom].sort(),
  };
}
