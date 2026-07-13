import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { readZipDirectory, readZipEntry, readZipText } from "../src/extract/zip";
import { OfficeExtractor, decodeXmlEntities } from "../src/extract/office-extractor";
import { EngramEngine } from "../src/engine";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import { NULL_LOGGER } from "../src/utils/logger";

/**
 * Minimal ZIP writer (tests only, node:zlib) — independent of the reader under
 * test, so the reader is validated against separately produced archives.
 */
function makeZip(entries: Record<string, string>, opts: { store?: boolean } = {}): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const header = (size: number) => {
    const b = new Uint8Array(size);
    return { b, v: new DataView(b.buffer) };
  };

  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(text);
    const data = opts.store ? raw : new Uint8Array(deflateRawSync(raw));
    const method = opts.store ? 0 : 8;

    const { b: lfh, v } = header(30);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(8, method, true);
    v.setUint32(18, data.length, true); // compressed size
    v.setUint32(22, raw.length, true); // uncompressed size
    v.setUint16(26, nameBytes.length, true);
    const lfhOffset = offset;
    chunks.push(lfh, nameBytes, data);
    offset += lfh.length + nameBytes.length + data.length;

    const { b: cd, v: cv } = header(46);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, lfhOffset, true);
    central.push(cd, nameBytes);
  }

  const cdStart = offset;
  for (const c of central) {
    chunks.push(c);
    offset += c.length;
  }
  const { b: eocd, v: ev } = header(22);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, Object.keys(entries).length, true);
  ev.setUint16(10, Object.keys(entries).length, true);
  ev.setUint32(12, offset - cdStart, true);
  ev.setUint32(16, cdStart, true);
  chunks.push(eocd);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const buf = (u8: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return copy.buffer;
};

describe("zip reader", () => {
  it("reads deflated and stored entries written by an independent writer", async () => {
    for (const store of [false, true]) {
      const zip = makeZip({ "a/b.xml": "<x>hello zip</x>", "c.txt": "plain" }, { store });
      const dir = readZipDirectory(zip);
      expect(dir.map((e) => e.name).sort()).toEqual(["a/b.xml", "c.txt"]);
      const text = new TextDecoder().decode(await readZipEntry(zip, dir[0]));
      expect(text).toBe("<x>hello zip</x>");
      expect(await readZipText(zip, "c.txt")).toBe("plain");
      expect(await readZipText(zip, "missing")).toBeNull();
    }
  });

  it("throws on non-zip input", () => {
    expect(() => readZipDirectory(new TextEncoder().encode("not a zip at all"))).toThrow(/not a zip/);
  });

  it("rejects entries whose declared inflated size exceeds the bomb cap", async () => {
    const zip = makeZip({ "word/document.xml": "<w:document/>" });
    const dir = readZipDirectory(zip);
    // Forge the declared uncompressed size (a decompression bomb lies here).
    const forged = { ...dir[0], uncompressedSize: 1024 * 1024 * 1024 };
    await expect(readZipEntry(zip, forged)).rejects.toThrow(/too large/);
    // And the extractor turns that into a clean null, never a throw.
    expect(await new OfficeExtractor().extract("a.docx", buf(zip))).toBeNull();
  });

  it("enforces a shared aggregate budget across entries of one archive", async () => {
    // The per-entry cap alone lets a crafted archive spread its payload over
    // many entries; entries sharing a budget must drain it collectively.
    const body = "x".repeat(1000);
    const zip = makeZip({ "ppt/slides/slide1.xml": body, "ppt/slides/slide2.xml": body });
    const dir = readZipDirectory(zip);
    const budget = { remaining: 1500 };
    await expect(readZipEntry(zip, dir[0], budget)).resolves.toHaveLength(1000);
    expect(budget.remaining).toBe(500);
    // Declared size over the remaining budget → rejected up front.
    await expect(readZipEntry(zip, dir[1], budget)).rejects.toThrow(/too large/);
    // A lying declared size is still caught while inflating.
    const lying = { ...dir[1], uncompressedSize: 100 };
    await expect(readZipEntry(zip, lying, budget)).rejects.toThrow(/past the cap/);
    // Stored (uncompressed) entries drain the budget too.
    const storedZip = makeZip({ "a.txt": body }, { store: true });
    const storedBudget = { remaining: 1200 };
    await readZipEntry(storedZip, readZipDirectory(storedZip)[0], storedBudget);
    expect(storedBudget.remaining).toBe(200);
  });
});

describe("OfficeExtractor", () => {
  const x = new OfficeExtractor();

  it("decodes XML entities including numeric references", () => {
    expect(decodeXmlEntities("a &amp; b &lt;c&gt; &#x41;&#66;")).toBe("a & b <c> AB");
  });

  it("replaces out-of-range numeric references instead of throwing", () => {
    // fromCodePoint throws above U+10FFFF; an unguarded call unwound through
    // the walker and nulled the whole document. Now it degrades to U+FFFD.
    expect(decodeXmlEntities("a&#x110000;b")).toBe("a�b");
    expect(decodeXmlEntities("a&#99999999;b")).toBe("a�b");
  });

  it("docx: a bad numeric reference does not null the whole document", async () => {
    const xml =
      `<w:document><w:body>` +
      `<w:p><w:r><w:t>Weka survey &#x110000; totals hold.</w:t></w:r></w:p>` +
      `</w:body></w:document>`;
    const md = await x.extract("Docs/Survey.docx", buf(makeZip({ "word/document.xml": xml })));
    expect(md).toContain("Weka survey");
    expect(md).toContain("totals hold.");
  });

  it("docx: paragraphs and heading styles", async () => {
    const xml =
      `<w:document><w:body>` +
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Migration plan</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>The cassowary rollout starts </w:t></w:r><w:r><w:t>in June &amp; July.</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>` +
      `</w:body></w:document>`;
    const md = await x.extract("Docs/Plan.docx", buf(makeZip({ "word/document.xml": xml })));
    expect(md).toContain("# Plan");
    expect(md).toContain("## Migration plan");
    expect(md).toContain("The cassowary rollout starts in June & July.");
  });

  it("pptx: one section per slide, numerically ordered", async () => {
    const slide = (t: string) => `<p:sld><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sld>`;
    const md = await x.extract(
      "Decks/Kickoff.pptx",
      buf(
        makeZip({
          "ppt/slides/slide2.xml": slide("second bowerbird point"),
          "ppt/slides/slide1.xml": slide("first lyrebird point"),
        }),
      ),
    );
    expect(md).toContain("# Kickoff");
    expect(md!.indexOf("## Slide 1")).toBeLessThan(md!.indexOf("## Slide 2"));
    expect(md!.indexOf("lyrebird")).toBeLessThan(md!.indexOf("bowerbird"));
  });

  it("xlsx: sheet names and shared strings", async () => {
    const md = await x.extract(
      "Sheets/Budget.xlsx",
      buf(
        makeZip({
          "xl/workbook.xml": `<workbook><sheets><sheet name="Q1 &amp; Q2" sheetId="1"/></sheets></workbook>`,
          "xl/sharedStrings.xml": `<sst><si><t>currawong budget line</t></si><si><r><t>split </t></r><r><t>run</t></r></si></sst>`,
        }),
      ),
    );
    expect(md).toContain("# Budget");
    expect(md).toContain("Sheets: Q1 & Q2");
    expect(md).toContain("currawong budget line");
    expect(md).toContain("split run");
  });

  it("xlsx: inline-string cells (streaming exporters, no sharedStrings)", async () => {
    const md = await x.extract(
      "Sheets/Export.xlsx",
      buf(
        makeZip({
          "xl/worksheets/sheet1.xml":
            `<worksheet><sheetData><row>` +
            `<c t="inlineStr"><is><t>kokako export row</t></is></c>` +
            `<c><v>42</v></c>` +
            `</row></sheetData></worksheet>`,
        }),
      ),
    );
    expect(md).toContain("kokako export row");
    expect(md).not.toContain("42"); // numeric cells stay skipped
  });

  it("odt: headings by outline level and paragraphs with spans", async () => {
    const xml =
      `<office:document-content><office:body><office:text>` +
      `<text:h text:outline-level="1">Fieldwork notes</text:h>` +
      `<text:p>The <text:span text:style-name="T1">brolga census</text:span> finished.</text:p>` +
      `</office:text></office:body></office:document-content>`;
    const md = await x.extract("Docs/Field.odt", buf(makeZip({ "content.xml": xml })));
    expect(md).toContain("# Field");
    expect(md).toContain("## Fieldwork notes");
    expect(md).toContain("The brolga census finished.");
  });

  it("odp: one section per slide", async () => {
    const xml =
      `<office:document-content><office:body><office:presentation>` +
      `<draw:page draw:name="page1"><draw:frame><text:p><text:span>takahe agenda item</text:span></text:p></draw:frame></draw:page>` +
      `<draw:page draw:name="page2"><draw:frame><text:p><text:span>kakapo next steps</text:span></text:p></draw:frame></draw:page>` +
      `</office:presentation></office:body></office:document-content>`;
    const md = await x.extract("Decks/Standup.odp", buf(makeZip({ "content.xml": xml })));
    expect(md).toContain("## Slide 1\n\ntakahe agenda item");
    expect(md).toContain("## Slide 2\n\nkakapo next steps");
  });

  it("ods: one section per named table with string cells", async () => {
    const xml =
      `<office:document-content><office:body><office:spreadsheet>` +
      `<table:table table:name="Inventory"><table:table-row>` +
      `<table:table-cell><text:p>weka counters</text:p></table:table-cell>` +
      `<table:table-cell office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell>` +
      `</table:table-row></table:table>` +
      `</office:spreadsheet></office:body></office:document-content>`;
    const md = await x.extract("Sheets/Stock.ods", buf(makeZip({ "content.xml": xml })));
    expect(md).toContain("## Inventory");
    expect(md).toContain("weka counters");
  });

  it("stays linear on adversarial unclosed-tag XML (no quadratic freeze)", async () => {
    // 2 MB of openers with no closing tags: the old regex approach took
    // minutes; the indexOf walker must finish in milliseconds.
    const hostile = "<si><t>x".repeat(250_000);
    const start = Date.now();
    const md = await x.extract("a.xlsx", buf(makeZip({ "xl/sharedStrings.xml": hostile })));
    expect(Date.now() - start).toBeLessThan(2000);
    expect(md).toBeNull(); // nothing well-formed to extract

    const hostileDocx = "<w:p><w:r><w:t>y".repeat(150_000);
    const start2 = Date.now();
    await x.extract("a.docx", buf(makeZip({ "word/document.xml": hostileDocx })));
    expect(Date.now() - start2).toBeLessThan(2000);
  });

  it("odp/ods keep mixed formatted content, not just pure runs", async () => {
    const odp =
      `<office:body><draw:page><draw:frame>` +
      `<text:p>See <text:span>bold takahe</text:span> now</text:p>` +
      `</draw:frame></draw:page></office:body>`;
    const md = await x.extract("Decks/Mix.odp", buf(makeZip({ "content.xml": odp })));
    expect(md).toContain("See bold takahe now");

    const ods =
      `<office:body><table:table table:name="Links"><table:table-row>` +
      `<table:table-cell><text:p>visit <text:a xlink:href="https://example.com">the kea page</text:a> today</text:p></table:table-cell>` +
      `</table:table-row></table:table></office:body>`;
    const md2 = await x.extract("Sheets/Links.ods", buf(makeZip({ "content.xml": ods })));
    expect(md2).toContain("## Links");
    expect(md2).toContain("visit the kea page today");
  });

  it("returns null for corrupt files, non-zip bytes, and text-free documents", async () => {
    expect(await x.extract("a.docx", buf(new TextEncoder().encode("MZ not a zip")))).toBeNull();
    expect(await x.extract("a.docx", buf(makeZip({ "word/document.xml": "<w:document/>" })))).toBeNull();
    expect(await x.extract("a.odt", buf(makeZip({ "wrong.xml": "<x/>" })))).toBeNull();
  });

  it("indexes a docx end-to-end through the engine", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const xml = `<w:document><w:body><w:p><w:r><w:t>the notornis contract review is due</w:t></w:r></w:p></w:body></w:document>`;
    adapter.seedBinary("Docs/Contract.docx", makeZip({ "word/document.xml": xml }));
    let t = 10_000;
    const engine = new EngramEngine(
      adapter,
      { ...DEFAULT_SETTINGS, indexAttachments: true },
      NULL_LOGGER,
      () => t++,
      { extractors: [new OfficeExtractor()] },
    );
    await engine.reindex();
    const results = await engine.search({ query: "notornis contract" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.notePath).toBe("Docs/Contract.docx");
  });
});
