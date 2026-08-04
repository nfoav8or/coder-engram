import { describe, it, expect } from "vitest";
import { ObsidianOcrExtractor } from "../src/core/obsidian-ocr-extractor";
import { EngramEngine } from "../src/engine";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import { NULL_LOGGER } from "../src/utils/logger";
import { TextExtractor } from "../src/extract/text-extractor";

/**
 * A stand-in for the slice of Obsidian's `App` this adapter touches, plus the
 * Text Extractor plugin's published API. The adapter is a thin shell, but the
 * parts worth pinning are its failure modes: a missing companion plugin, a
 * companion that throws, and the setting being off.
 */
function makeApp(opts: { api?: unknown; file?: unknown } = {}) {
  return {
    plugins: { plugins: opts.api === undefined ? {} : { "text-extractor": { api: opts.api } } },
    vault: { getAbstractFileByPath: () => opts.file ?? { stat: { mtime: 1 }, path: "Images/a.png" } },
  } as never;
}

const okApi = {
  extractText: async () => "invoice total 42 USD",
  canFileBeExtracted: () => true,
};

describe("ObsidianOcrExtractor", () => {
  it("lists image extensions only while the setting is on", () => {
    const on = new ObsidianOcrExtractor(makeApp({ api: okApi }), () => true);
    const off = new ObsidianOcrExtractor(makeApp({ api: okApi }), () => false);
    expect(on.extensions).toContain(".png");
    // Empty so the scanner never lists image files at all when disabled.
    expect(off.extensions).toEqual([]);
  });

  it("returns the companion plugin's text under a title heading", async () => {
    const x = new ObsidianOcrExtractor(makeApp({ api: okApi }), () => true);
    const md = await x.extract("Images/receipt.png");
    expect(md).toBe("# receipt\n\ninvoice total 42 USD");
  });

  it("extracts nothing when Text Extractor is not installed", async () => {
    const x = new ObsidianOcrExtractor(makeApp(), () => true);
    expect(await x.extract("Images/a.png")).toBeNull();
  });

  it("extracts nothing when the setting is off, even with the plugin present", async () => {
    const x = new ObsidianOcrExtractor(makeApp({ api: okApi }), () => false);
    expect(await x.extract("Images/a.png")).toBeNull();
  });

  it("survives a companion plugin that throws or returns nothing", async () => {
    const throwing = new ObsidianOcrExtractor(
      makeApp({ api: { extractText: async () => { throw new Error("worker died"); }, canFileBeExtracted: () => true } }),
      () => true,
    );
    expect(await throwing.extract("Images/a.png")).toBeNull();

    const blank = new ObsidianOcrExtractor(
      makeApp({ api: { extractText: async () => "   \n ", canFileBeExtracted: () => true } }),
      () => true,
    );
    // Whitespace-only OCR output is no text, not an empty document to index.
    expect(await blank.extract("Images/a.png")).toBeNull();
  });

  it("respects the companion's own verdict on a file it cannot read", async () => {
    const x = new ObsidianOcrExtractor(
      makeApp({ api: { ...okApi, canFileBeExtracted: () => false } }),
      () => true,
    );
    expect(await x.extract("Images/a.png")).toBeNull();
  });

  it("returns null when the path resolves to a folder rather than a file", async () => {
    const x = new ObsidianOcrExtractor(makeApp({ api: okApi, file: { children: [] } }), () => true);
    expect(await x.extract("Images")).toBeNull();
  });
});

describe("engine integration with a setting-gated extractor", () => {
  it("does not read the file for an extractor that works from the path alone", async () => {
    // OCR hands the path to a companion plugin that owns its own cache, so
    // reading the image here would load every picture in the vault into memory
    // only to discard it.
    const adapter = new InMemoryVaultAdapter("v", {});
    adapter.seedBinary("Images/big.png", new Uint8Array([9, 9, 9]));
    let reads = 0;
    const originalRead = adapter.readBinary.bind(adapter);
    adapter.readBinary = async (p: string) => {
      reads++;
      return originalRead(p);
    };
    const pathOnly: TextExtractor = {
      extensions: [".png"],
      needsBytes: false,
      async extract(path: string, data: ArrayBuffer) {
        expect(data.byteLength).toBe(0);
        return `# ${path}\n\ntakahe ledger`;
      },
    };
    let t = 10_000;
    const engine = new EngramEngine(
      adapter,
      { ...DEFAULT_SETTINGS, indexAttachments: true },
      NULL_LOGGER,
      () => t++,
      { extractors: [pathOnly] },
    );
    await engine.reindex();
    expect((await engine.search({ query: "takahe ledger" }))[0]?.chunk.notePath).toBe("Images/big.png");
    expect(reads).toBe(0);
  });

  it("stops indexing and drops cached text once the extractor reports no extensions", async () => {
    // The OCR extractor reports an empty extension list while its setting is
    // off. That is what keeps images out of the scan AND what evicts already
    // extracted text: the path leaves the live set, so the extraction cache
    // prunes it. Worth pinning — OCR output can be as sensitive as a note.
    const adapter = new InMemoryVaultAdapter("v", {});
    adapter.seedBinary("Images/receipt.png", new Uint8Array([1, 2, 3]));
    let enabled = true;
    const gated: TextExtractor = {
      get extensions() {
        return enabled ? [".png"] : [];
      },
      async extract() {
        return "# receipt\n\nkereru invoice total";
      },
    };
    let t = 10_000;
    const settings = { ...DEFAULT_SETTINGS, indexAttachments: true };
    const engine = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++, { extractors: [gated] });

    await engine.reindex();
    expect((await engine.search({ query: "kereru invoice" }))[0]?.chunk.notePath).toBe("Images/receipt.png");
    const cachePath = "Claude Code/Index/extracted.json";
    expect(await adapter.read(cachePath)).toContain("kereru invoice");

    enabled = false;
    await engine.reindex();
    expect(await engine.search({ query: "kereru invoice" })).toHaveLength(0);
    expect(await adapter.read(cachePath)).not.toContain("kereru invoice");
  });
});
