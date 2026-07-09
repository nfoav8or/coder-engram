import { describe, it, expect } from "vitest";
import { PlainTextExtractor } from "../src/extract/plain-text-extractor";
import { RtfExtractor, rtfToText } from "../src/extract/rtf-extractor";
import { EngramEngine } from "../src/engine";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import { NULL_LOGGER } from "../src/utils/logger";

const buf = (s: string): ArrayBuffer => {
  const b = new TextEncoder().encode(s);
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return copy.buffer;
};

describe("PlainTextExtractor", () => {
  const x = new PlainTextExtractor();

  it("wraps txt and csv content under a title heading", async () => {
    const md = await x.extract("Data/results.txt", buf("bittern survey complete"));
    expect(md).toBe("# results\n\nbittern survey complete");
    const csv = await x.extract("Data/counts.csv", buf("species,count\nbittern,4\n"));
    expect(csv).toContain("# counts");
    expect(csv).toContain("bittern,4");
  });

  it("returns null for empty/whitespace files", async () => {
    expect(await x.extract("a.txt", buf("   \n  "))).toBeNull();
  });
});

describe("rtfToText", () => {
  it("extracts body text, decodes escapes, and honors paragraph breaks", () => {
    const rtf =
      `{\\rtf1\\ansi{\\fonttbl{\\f0 Calibri;}}{\\colortbl;\\red0\\green0\\blue0;}` +
      `\\f0\\fs22 First spoonbill line.\\par Second line with caf\\'e9 and \\u8212? dash.\\par}`;
    const text = rtfToText(rtf);
    expect(text).toContain("First spoonbill line.");
    expect(text).toContain("Second line with café and — dash.");
    expect(text).not.toContain("Calibri"); // font table skipped
    expect(text.indexOf("First")).toBeLessThan(text.indexOf("Second"));
  });

  it("skips metadata destinations, escaped braces survive, \\uc fallbacks swallowed", () => {
    const rtf =
      `{\\rtf1{\\info{\\author Secret Author}}\\uc2 A \\u960?? end \\{literal\\} \\\\slash}`;
    const text = rtfToText(rtf);
    expect(text).not.toContain("Secret Author");
    expect(text).toContain("A π end"); // \uc2 → two fallback chars ("??") swallowed
    expect(text).toContain("{literal}");
    expect(text).toContain("\\slash");
  });

  it("jumps \\bin runs and stays linear on adversarial input", () => {
    // \bin swallows raw bytes that may contain braces/backslashes.
    expect(rtfToText(`{\\rtf1 before\\bin5 }}\\}}after}`)).toBe("beforeafter");
    // 2 MB of pathological unclosed groups and bare backslashes must finish fast.
    const hostile = "{\\rtf1 " + "{\\".repeat(500_000) + "x";
    const start = Date.now();
    rtfToText(hostile);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("stays linear on long space runs (the cleanup regex trap)", () => {
    // /[ \t]+\n/ was quadratic on space runs: measured 4× per size doubling
    // (10.9s at 128KB). The linear trimEnd cleanup must handle 2MB instantly.
    const padded = "{\\rtf1 a" + " ".repeat(2_000_000) + "b\\par}";
    const start = Date.now();
    const text = rtfToText(padded);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(text).toContain("a");
    expect(text).toContain("b");
  });

  it("bounds group-stack memory on brace floods", () => {
    // 5MB of "{" used to allocate one stack object each (~3GB at the read
    // cap); depth is now capped with an overflow counter — and matched
    // closers must still unwind correctly past the cap.
    const flood = "{\\rtf1 x" + "{".repeat(5_000_000) + "y" + "}".repeat(5_000_000) + "z}";
    const start = Date.now();
    expect(rtfToText(flood)).toBe("xyz");
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("counts a control symbol as one unicode fallback and survives bad \\u values", () => {
    // \{ after \uc1舒 is the fallback — it must be swallowed, not leak
    // the swallow onto the next real character.
    expect(rtfToText(`{\\rtf1\\uc1\\u8212\\{ab}`)).toBe("—ab");
    // An out-of-range \u escape must not null the whole document.
    expect(rtfToText(`{\\rtf1 keep \\u-99999? this}`)).toContain("keep");
    expect(rtfToText(`{\\rtf1 keep \\u-99999? this}`)).toContain("this");
  });

  it("caps \\uc so an absurd fallback count can't swallow the whole body", () => {
    // An unbounded \uc set pendingUc huge after each \uN escape, eating all
    // following text; the cap limits the swallow so the body survives.
    const body = "kokako ".repeat(30); // 210 chars, well past the 64-char cap
    expect(rtfToText(`{\\rtf1\\uc999999\\u333 ${body}}`)).toContain("kokako");
  });

  it("does not let a \\uN fallback swallow text across a group boundary", () => {
    // \u333 leaves a pending fallback char; the closing brace must clear it so
    // the parent group's next character isn't eaten.
    expect(rtfToText(`{\\rtf1{\\uc1\\u333}Xylophone survives}`)).toContain("Xylophone");
  });
});

describe("RtfExtractor", () => {
  it("requires the RTF magic and titles the output", async () => {
    const x = new RtfExtractor();
    expect(await x.extract("a.rtf", buf("plain text, not rtf"))).toBeNull();
    const md = await x.extract("Docs/Old memo.rtf", buf(`{\\rtf1 kotuku memo body\\par}`));
    expect(md).toContain("# Old memo");
    expect(md).toContain("kotuku memo body");
  });
});

describe("engine integration", () => {
  it("indexes txt and rtf attachments end-to-end", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    adapter.seedBinary("Data/log.txt", new TextEncoder().encode("the whio census wrapped up"));
    adapter.seedBinary(
      "Docs/memo.rtf",
      new TextEncoder().encode(`{\\rtf1 the hoiho contract renews\\par}`),
    );
    let t = 10_000;
    const engine = new EngramEngine(
      adapter,
      { ...DEFAULT_SETTINGS, indexAttachments: true },
      NULL_LOGGER,
      () => t++,
      { extractors: [new PlainTextExtractor(), new RtfExtractor()] },
    );
    await engine.reindex();
    const txtHits = await engine.search({ query: "whio census" });
    expect(txtHits[0]?.chunk.notePath).toBe("Data/log.txt");
    const rtfHits = await engine.search({ query: "hoiho contract" });
    expect(rtfHits[0]?.chunk.notePath).toBe("Docs/memo.rtf");
  });
});
