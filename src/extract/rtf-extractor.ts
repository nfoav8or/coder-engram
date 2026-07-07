/**
 * rtf-extractor — legacy Rich Text Format (Word's older sibling), zero deps.
 *
 * RTF is a flat stream of control words, groups, and text — no ZIP, no XML.
 * This is a single-pass character walker (same discipline as the office
 * extractor: untrusted bytes must cost O(n), never a frozen renderer — every
 * branch strictly advances the index). Destination groups that carry no body
 * text (font/color tables, stylesheets, metadata, embedded images/objects)
 * are skipped whole; `\uN` unicode escapes and `\'xx` hex escapes are decoded;
 * `\binN` raw-binary runs are jumped over.
 */

import { TextExtractor, attachmentTitle } from "./text-extractor";

/** Destinations whose group content is never body text. */
const SKIP_DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "info",
  "pict",
  "object",
  "header",
  "footer",
  "footnote",
  "themedata",
  "colorschememapping",
  "latentstyles",
  "datastore",
  "xmlnstbl",
]);

/** Extract the plain text of an RTF document. Exported for tests. */
export function rtfToText(rtf: string): string {
  const out: string[] = [];
  const n = rtf.length;
  // Group stack entries: are we inside a skipped destination, and the \uc
  // fallback-byte count (how many chars follow each \uN as ANSI fallback).
  // Depth is capped: crafted input is all-"{" (measured ~3GB of stack objects
  // at the 50MB read cap without a bound); beyond the cap an integer counts
  // the excess — a bare "{" copies its parent state, so no fidelity is lost
  // until a control word inside an overflowed group mutates shared state,
  // which only pathological input ever reaches.
  const MAX_DEPTH = 4096;
  const stack: { skip: boolean; uc: number }[] = [{ skip: false, uc: 1 }];
  let overflow = 0;
  let i = 0;
  /** Chars still to swallow as the ANSI fallback of a preceding \uN. */
  let pendingUc = 0;

  const top = () => stack[stack.length - 1];

  while (i < n) {
    const c = rtf[i];
    if (c === "{") {
      if (stack.length < MAX_DEPTH) stack.push({ ...top() });
      else overflow++;
      i++;
    } else if (c === "}") {
      if (overflow > 0) overflow--;
      else if (stack.length > 1) stack.pop();
      i++;
    } else if (c === "\\") {
      const next = rtf[i + 1];
      if (next === undefined) break;
      // Control symbols: escaped braces/backslash, \~ nbsp, \- \_ hyphens.
      if (!/[a-zA-Z]/.test(next)) {
        if (next === "'") {
          const hex = rtf.slice(i + 2, i + 4);
          if (pendingUc > 0) pendingUc--;
          else if (!top().skip && /^[0-9a-fA-F]{2}$/.test(hex)) {
            out.push(String.fromCharCode(parseInt(hex, 16)));
          }
          i += 4;
        } else {
          // A control symbol counts as ONE \uN fallback char, like \'xx does.
          if (pendingUc > 0) pendingUc--;
          else if (!top().skip && (next === "{" || next === "}" || next === "\\")) {
            out.push(next);
          } else if (!top().skip && next === "~") {
            out.push(" ");
          }
          // \* marks the group as an optional destination; unknown ones are
          // usually metadata — skip unless a known text destination follows.
          if (next === "*") top().skip = true;
          i += 2;
        }
        continue;
      }
      // Control word: letters then an optional signed number then a space.
      let j = i + 1;
      while (j < n && /[a-zA-Z]/.test(rtf[j])) j++;
      const word = rtf.slice(i + 1, j);
      let numStr = "";
      if (rtf[j] === "-") {
        numStr = "-";
        j++;
      }
      while (j < n && /[0-9]/.test(rtf[j])) {
        numStr += rtf[j];
        j++;
      }
      if (rtf[j] === " ") j++; // the delimiter space is part of the control word
      const num = numStr === "" || numStr === "-" ? null : parseInt(numStr, 10);

      if (SKIP_DESTINATIONS.has(word)) {
        top().skip = true;
      } else if (word === "u" && num !== null) {
        const cp = num < 0 ? num + 65536 : num;
        // Guard the range — fromCodePoint throws on out-of-range values, and
        // one malformed escape must not null out the whole document.
        if (!top().skip && cp > 0 && cp <= 0x10ffff) {
          out.push(String.fromCodePoint(cp));
        }
        pendingUc = top().uc;
      } else if (word === "uc" && num !== null) {
        top().uc = Math.max(0, num);
      } else if (word === "bin" && num !== null && num > 0) {
        j += num; // raw binary bytes follow the delimiter — jump them
      } else if (word === "par" || word === "line" || word === "row") {
        if (!top().skip) out.push("\n");
      } else if (word === "tab" || word === "cell") {
        if (!top().skip) out.push(" ");
      }
      i = j;
    } else {
      if (c !== "\r" && c !== "\n") {
        if (pendingUc > 0) pendingUc--;
        else if (!top().skip) out.push(c);
      }
      i++;
    }
  }
  // Cleanup must stay linear: /[ \t]+\n/ is quadratic on long space runs
  // (measured 4× per size doubling), so trim line ends with split/trimEnd.
  return out
    .join("")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class RtfExtractor implements TextExtractor {
  readonly extensions = [".rtf"];

  async extract(path: string, data: ArrayBuffer): Promise<string | null> {
    const raw = new TextDecoder("utf-8").decode(data);
    if (!raw.startsWith("{\\rtf")) return null;
    try {
      const text = rtfToText(raw);
      if (!text) return null;
      return `# ${attachmentTitle(path)}\n\n${text}`;
    } catch {
      return null;
    }
  }
}
