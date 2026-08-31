/**
 * symbol-extractor — the names a chunk's fenced code DECLARES.
 *
 * Retrieval treats a note as prose, so a chunk containing
 * `export function resolveInVault(...)` matched the query "resolveInVault" only
 * as an ordinary body term — competing on frequency with every passing mention
 * of the same name. The declaration and the mention scored the same, which is
 * backwards: for a code identifier, the place it is defined is almost always
 * the passage worth returning.
 *
 * The extraction is deliberately shallow. No parser, no grammar per language,
 * no dependency: a handful of declaration keywords that mean the same thing
 * across the languages people paste into notes. It will miss things, and that
 * is the correct trade — a missed symbol costs a boost, while a wrong one
 * pollutes the index and mis-ranks a note for a name it never defined.
 *
 * Only fenced code is read. Prose that happens to contain the word "class" is
 * not a declaration, and treating it as one would put a symbol on almost every
 * chunk, which is the same as putting it on none.
 */

import { scanMarkdownLines } from "./markdown-chunker";

/**
 * Symbols kept per chunk.
 *
 * A chunk is at most a couple of thousand characters, so a legitimate one holds
 * a few declarations. A cap bounds what a pathological (generated, minified)
 * block can add to every persisted index, and losing the tail of an
 * already-implausible list costs nothing real.
 */
export const MAX_SYMBOLS_PER_CHUNK = 32;

/**
 * Declaration forms, one per line-shape rather than per language, because the
 * same keyword means the same thing nearly everywhere it appears.
 */
const DECLARATIONS: RegExp[] = [
  // function/class/interface/type/enum/struct/trait/impl/namespace/module NAME
  /\b(?:function|class|interface|type|enum|struct|trait|impl|namespace|module|record)\s+([A-Za-z_$][\w$]*)/g,
  // Python def, Rust fn, Go func, shell/Perl sub, Pascal procedure
  /\b(?:def|fn|func|sub|procedure)\s+([A-Za-z_$][\w$]*)/g,
  // Go methods: func (r *Repo) Save(
  /\bfunc\s*\([^)]*\)\s*([A-Za-z_$][\w$]*)\s*\(/g,
  // const/let/var NAME = (…) | function | async | <generic> — bound to a
  // callable only. Every other assignment is a value, and indexing those would
  // make a symbol out of every local variable in every snippet.
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\(|<)/g,
];

/** Names declared by fenced code inside `text`, deduplicated and capped. */
export function extractSymbols(text: string): string[] {
  if (!text.includes("```") && !text.includes("~~~")) return [];
  const found = new Set<string>();
  scanMarkdownLines(text.split("\n"), (_i, line, _heading, fenced) => {
    if (!fenced || found.size >= MAX_SYMBOLS_PER_CHUNK) return;
    // The delimiter line carries a language tag, not a declaration.
    if (/^\s*(```|~~~)/.test(line)) return;
    for (const re of DECLARATIONS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        found.add(m[1]);
        if (found.size >= MAX_SYMBOLS_PER_CHUNK) return;
      }
    }
  });
  return [...found];
}
