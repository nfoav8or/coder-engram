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

import { TextExtractor, attachmentTitle, normalizeExtractedText } from "./text-extractor";

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

/**
 * Windows-1252's 0x80-0x9F range, which is where it differs from Unicode.
 *
 * `\\'xx` carries a raw BYTE, and treating that byte as a code point is only
 * right below 0x80 and at or above 0xA0. In between sit the characters Word's
 * autocorrect produces by default — curly quotes, en and em dash, ellipsis,
 * bullet — so an ordinary Word-authored RTF decoded them to INVISIBLE C1
 * control characters. That is worse than a wrong glyph: `it\\'92s` became
 * `it<U+0092>s`, and since the tokenizer splits on anything that is not a
 * letter or a number, the word was indexed as `it` and `s`. The note could not
 * be found by searching for a word that is plainly written in it.
 *
 * Only this range is mapped, and only as CP1252 — the codepage `\\ansi` means by
 * default and the one Word writes for Western text. RTF can declare others via
 * `\\ansicpg`, and those are still decoded byte-as-code-point: unchanged from
 * today, and not made worse, since what this replaces was never findable.
 * Undefined CP1252 slots keep their original value.
 */
const CP1252_HIGH = "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";

function decodeAnsiByte(byte: number): string {
  if (byte < 0x80 || byte > 0x9f) return String.fromCharCode(byte);
  return CP1252_HIGH[byte - 0x80];
}

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
      // A \uN fallback run never crosses a group boundary — the fallback bytes
      // immediately follow the escape in the same group — so a stale pendingUc
      // must not swallow the next group's text.
      pendingUc = 0;
      if (stack.length < MAX_DEPTH) stack.push({ ...top() });
      else overflow++;
      i++;
    } else if (c === "}") {
      pendingUc = 0;
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
            out.push(decodeAnsiByte(parseInt(hex, 16)));
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
      // A control word's parameter is a signed 32-bit value, so a longer digit
      // run is malformed. Bounding what is KEPT (while still consuming the run)
      // stops a digit flood from building a huge string, and stops `\binN` from
      // computing an offset past any finite position — `parseInt` of twenty
      // digits is 1e20, `j += num` then exceeded the input length, and the scan
      // ended there, silently dropping the rest of the document.
      while (j < n && /[0-9]/.test(rtf[j])) {
        if (numStr.length < 11) numStr += rtf[j];
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
        // Cap the fallback count like every other untrusted quantity here: a
        // real \uc is a single digit (bytes of one codepoint's ANSI fallback),
        // so an absurd value only serves to swallow the whole body as fallback.
        top().uc = Math.min(Math.max(0, num), 64);
      } else if (word === "bin" && num !== null && num > 0) {
        // Raw binary bytes follow the delimiter — jump them, but only a count
        // the document could actually contain. A declared length longer than
        // the input that remains cannot be honest, and honouring it jumped
        // past the end, ending the scan and silently dropping every remaining
        // word of the document. Disbelieving it costs at most some binary
        // rendered as text; believing it costs the rest of the file.
        if (j + num <= n) j += num;
      } else if (word === "par" || word === "line" || word === "row") {
        if (!top().skip) out.push("\n");
      } else if (word === "tab" || word === "cell") {
        if (!top().skip) out.push(" ");
      }
      i = j;
    } else if (c === "\r" || c === "\n") {
      // Raw line breaks are layout, not text — \par carries the real one.
      i++;
    } else {
      // Plain-text run, taken in one slice. Per character it would cost one
      // array entry per byte of the document (~200MB of heap on a 20MB file)
      // to build text the extraction cap then truncates to 1MB. Nothing in a
      // run can change `skip` or the group depth, since a run stops at every
      // character that could.
      let j = i + 1;
      while (j < n) {
        const ch = rtf[j];
        if (ch === "{" || ch === "}" || ch === "\\" || ch === "\r" || ch === "\n") break;
        j++;
      }
      // \uN fallback bytes are swallowed one character at a time.
      while (i < j && pendingUc > 0) {
        pendingUc--;
        i++;
      }
      if (i < j && !top().skip) out.push(rtf.slice(i, j));
      i = j;
    }
  }
  return normalizeExtractedText(out.join("")).trim();
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
