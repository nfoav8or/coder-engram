import { describe, it, expect } from "vitest";
import { PlainTextExtractor } from "../src/extract/plain-text-extractor";

const utf8 = (s: string): ArrayBuffer => {
  const b = new TextEncoder().encode(s);
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return copy.buffer;
};

const utf8WithBom = (s: string): ArrayBuffer => {
  const body = new TextEncoder().encode(s);
  const out = new Uint8Array(body.byteLength + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out.buffer;
};

/** Encode as UTF-16 (BMP-only test strings) with a leading BOM, either endian. */
const utf16WithBom = (s: string, littleEndian: boolean): ArrayBuffer => {
  const out = new Uint8Array(2 + s.length * 2);
  const v = new DataView(out.buffer);
  if (littleEndian) {
    v.setUint8(0, 0xff);
    v.setUint8(1, 0xfe);
  } else {
    v.setUint8(0, 0xfe);
    v.setUint8(1, 0xff);
  }
  for (let i = 0; i < s.length; i++) {
    v.setUint16(2 + i * 2, s.charCodeAt(i), littleEndian);
  }
  return out.buffer;
};

describe("PlainTextExtractor BOM sniffing", () => {
  const x = new PlainTextExtractor();

  it("decodes plain utf-8 with no BOM", async () => {
    const md = await x.extract("Data/results.txt", utf8("bittern survey complete"));
    expect(md).toBe("# results\n\nbittern survey complete");
  });

  it("decodes utf-8 with a BOM, stripping it from the output", async () => {
    const md = await x.extract("Data/results.txt", utf8WithBom("bittern survey complete"));
    expect(md).toBe("# results\n\nbittern survey complete");
    expect(md).not.toContain("﻿");
  });

  it("decodes utf-16le (BOM-sniffed), previously mangled by a hard-coded utf-8 decode", async () => {
    const md = await x.extract("Data/results.txt", utf16WithBom("bittern survey complete", true));
    expect(md).toBe("# results\n\nbittern survey complete");
    expect(md).not.toContain("﻿");
  });

  it("decodes utf-16be (BOM-sniffed), previously mangled by a hard-coded utf-8 decode", async () => {
    const md = await x.extract("Data/results.txt", utf16WithBom("bittern survey complete", false));
    expect(md).toBe("# results\n\nbittern survey complete");
    expect(md).not.toContain("﻿");
  });
});
