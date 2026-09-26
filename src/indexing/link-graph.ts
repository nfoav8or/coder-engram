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
import { foldForCompare } from "../utils/text";

/** Basename of a path/target, without a `.md` extension, folded for comparison
 * (NFC + lowercase, like every other name comparison here — macOS hands back
 * decomposed filenames, and a link typed elsewhere is composed, so folding case
 * alone left `Café` unable to find itself). This is the key an Obsidian-style
 * link resolves by. Anchors (`#…`) and aliases (`|…`) are stripped first so
 * `[[Note#Heading]]` and `note.md#h` both key on "note". */
export function linkKey(target: string): string {
  const noAnchor = target.split(/[#|]/)[0];
  const base = noAnchor.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  return foldForCompare(base.replace(/\.md$/i, "").trim());
}

export interface RelatedNotes {
  /** Indexed notes this note links TO (via its outbound links). */
  linksTo: string[];
  /** Indexed notes that link TO this note (backlinks). */
  linkedFrom: string[];
}

interface LinkGraph {
  /** basename key -> indexed note paths carrying that basename (collisions kept). */
  byKey: Map<string, Set<string>>;
  /** notePath -> distinct resolved keys of its outbound links. */
  outKeysByNote: Map<string, Set<string>>;
  /** basename key -> notes with an outbound link resolving to that key. */
  linkersByKey: Map<string, Set<string>>;
  /** notePath -> every key it answers to: its basename and each alias. */
  keysByNote: Map<string, Set<string>>;
}

/** Graph per chunks-array identity. `IndexManager.refresh` keeps the previous
 * array on an all-unchanged refresh and swaps a new one otherwise — the same
 * identity contract `LexicalRetriever` keys its corpus-stats memo on — so a
 * WeakMap entry is exactly as fresh as the index it was built from, and a full
 * per-call rebuild (a whole-corpus pass per request) is paid once per reindex. */
const graphCache = new WeakMap<IndexedChunk[], LinkGraph>();

function buildGraph(chunks: IndexedChunk[]): LinkGraph {
  // notePath -> its distinct outbound link targets (raw), collected across
  // chunks. The de-duplication is load-bearing, not tidiness: `links` is
  // note-level metadata copied onto EVERY chunk of the note, so a note that
  // chunks into three carries its whole link list three times, and keying them
  // straight from the chunks would re-key each one per chunk.
  const outByNote = new Map<string, Set<string>>();
  const byKey = new Map<string, Set<string>>();
  const keysByNote = new Map<string, Set<string>>();

  const register = (key: string, notePath: string) => {
    let keySet = byKey.get(key);
    if (!keySet) byKey.set(key, (keySet = new Set()));
    keySet.add(notePath);
    let keys = keysByNote.get(notePath);
    if (!keys) keysByNote.set(notePath, (keys = new Set()));
    keys.add(key);
  };
  for (const c of chunks) {
    register(linkKey(c.notePath), c.notePath);
    // A frontmatter alias resolves a link exactly as the basename does in
    // Obsidian; without this, a note referenced mostly by its alias reported
    // no backlinks. Note-level metadata copied onto every chunk, so the set
    // absorbs the repeats. An alias equal to another note's basename is the
    // same honest over-approximation a basename collision already is.
    for (const alias of c.aliases) {
      const key = linkKey(alias);
      if (key) register(key, c.notePath);
    }

    let outs = outByNote.get(c.notePath);
    if (!outs) outByNote.set(c.notePath, (outs = new Set()));
    for (const l of c.links) outs.add(l);
  }

  const outKeysByNote = new Map<string, Set<string>>();
  const linkersByKey = new Map<string, Set<string>>();
  for (const [note, outs] of outByNote) {
    const keys = new Set<string>();
    for (const t of outs) {
      const k = linkKey(t);
      keys.add(k);
      let linkers = linkersByKey.get(k);
      if (!linkers) linkersByKey.set(k, (linkers = new Set()));
      linkers.add(note);
    }
    outKeysByNote.set(note, keys);
  }

  return { byKey, outKeysByNote, linkersByKey, keysByNote };
}

/**
 * Resolve the link graph over `chunks` and return the notes related to
 * `notePath`. `notePath` must be an indexed note's exact path; the caller is
 * responsible for the indexed-only gate. Results are sorted and never include
 * `notePath` itself.
 */
export function relatedNotes(notePath: string, chunks: IndexedChunk[]): RelatedNotes {
  let graph = graphCache.get(chunks);
  if (!graph) {
    graph = buildGraph(chunks);
    graphCache.set(chunks, graph);
  }

  const linksTo = new Set<string>();
  for (const k of graph.outKeysByNote.get(notePath) ?? []) {
    for (const p of graph.byKey.get(k) ?? []) if (p !== notePath) linksTo.add(p);
  }

  // Backlinks arrive under any key the note answers to, alias or basename.
  const linkedFrom = new Set<string>();
  for (const key of graph.keysByNote.get(notePath) ?? [linkKey(notePath)]) {
    for (const note of graph.linkersByKey.get(key) ?? []) {
      if (note !== notePath) linkedFrom.add(note);
    }
  }

  return {
    linksTo: [...linksTo].sort(),
    linkedFrom: [...linkedFrom].sort(),
  };
}
