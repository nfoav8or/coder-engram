import { describe, it, expect } from "vitest";
import { EngramEngine, ATTACHMENT_TEXT_BUDGET_CHARS, ATTACHMENT_MAX_BYTES } from "../src/engine";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { DEFAULT_SETTINGS, EngramSettings, migrateSettings } from "../src/settings/settings";
import { NULL_LOGGER } from "../src/utils/logger";
import { TextExtractor, renderPdfMarkdown, joinPdfTextItems } from "../src/extract/text-extractor";
import { ExtractionCache } from "../src/extract/extraction-cache";
import { CanvasExtractor } from "../src/extract/canvas-extractor";
import { PlainTextExtractor } from "../src/extract/plain-text-extractor";

/** Extracts "pages" from the file's bytes (tests seed text under a .pdf path). */
class FakePdfExtractor implements TextExtractor {
  readonly extensions = [".pdf"];
  calls = 0;
  async extract(path: string, data: ArrayBuffer): Promise<string | null> {
    this.calls++;
    const text = new TextDecoder().decode(data).trim();
    if (!text) return null;
    const basename = path.slice(path.lastIndexOf("/") + 1).replace(/\.pdf$/i, "");
    return renderPdfMarkdown(basename, [text]);
  }
}

function makeEngine(seed: Record<string, string>, overrides: Partial<EngramSettings> = {}) {
  const adapter = new InMemoryVaultAdapter("v", seed);
  const settings: EngramSettings = { ...DEFAULT_SETTINGS, indexAttachments: true, ...overrides };
  const extractor = new FakePdfExtractor();
  let t = 10_000;
  const engine = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++, {
    extractors: [extractor],
  });
  return { adapter, engine, extractor };
}

describe("attachment indexing (fake PDF extractor)", () => {
  it("indexes attachment text; search and note reads treat it like a note", async () => {
    const { engine } = makeEngine({
      "Notes/a.md": "# A\nordinary note content",
      "Papers/telemetry.pdf": "peregrine falcon telemetry protocols and results",
    });
    const stats = await engine.reindex();
    expect(stats.noteCount).toBe(2);

    const results = await engine.search({ query: "peregrine telemetry" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.notePath).toBe("Papers/telemetry.pdf");
    // The page pseudo-structure flows through: "Page 1" is the chunk heading.
    expect(results[0].chunk.heading).toBe("Page 1");

    const chunks = engine.getNoteChunks("Papers/telemetry.pdf");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.text).join("\n")).toContain("falcon telemetry");
  });

  it("is off by default and gated by excluded folders/patterns", async () => {
    const seed = {
      "Secret/hidden.pdf": "classified sturgeon data",
      "Papers/open.pdf": "public heron data",
    };
    const off = makeEngine(seed, { indexAttachments: false });
    await off.engine.reindex();
    expect((await off.engine.search({ query: "heron" })).length).toBe(0);
    expect(off.extractor.calls).toBe(0);

    const gated = makeEngine(seed, { excludedFolders: ["Secret"] });
    await gated.engine.reindex();
    expect((await gated.engine.search({ query: "sturgeon" })).length).toBe(0);
    expect((await gated.engine.search({ query: "heron" })).length).toBeGreaterThan(0);
  });

  it("extracts once per (path, mtime): refreshes and reindexes reuse the cache", async () => {
    const { adapter, engine, extractor } = makeEngine({
      "Papers/doc.pdf": "original osprey content",
    });
    await engine.reindex();
    expect(extractor.calls).toBe(1);

    await engine.refresh(); // nothing changed
    await engine.reindex(); // full rebuild still reuses the extraction cache
    expect(extractor.calls).toBe(1);

    adapter.touch("Papers/doc.pdf", "updated osprey content with kestrel note");
    await engine.refresh();
    expect(extractor.calls).toBe(2);
    expect((await engine.search({ query: "kestrel" })).length).toBeGreaterThan(0);
  });

  it("persists the extraction cache: a fresh engine re-emits without re-extracting", async () => {
    const seed = { "Papers/doc.pdf": "goshawk migration notes" };
    const first = makeEngine(seed);
    await first.engine.reindex();
    expect(first.extractor.calls).toBe(1);

    // New engine over the SAME adapter (same vault state, same Index/ files).
    const extractor2 = new FakePdfExtractor();
    let t = 50_000;
    const engine2 = new EngramEngine(
      first.adapter,
      { ...DEFAULT_SETTINGS, indexAttachments: true },
      NULL_LOGGER,
      () => t++,
      { extractors: [extractor2] },
    );
    await engine2.reindex();
    expect(extractor2.calls).toBe(0); // served from Index/extracted.json
    expect((await engine2.search({ query: "goshawk" })).length).toBeGreaterThan(0);
  });

  it("re-chunks attachments when a cache-version bump discards the extraction cache", async () => {
    // An extractor fix ships via a CACHE_VERSION bump: the file's bytes and
    // mtime are unchanged, but re-extraction yields different text. Without
    // forcing past the index's mtime short-circuit, the corrected text never
    // reaches already-indexed chunks.
    const seed = { "Papers/doc.pdf": "merlin field notes" };
    const first = makeEngine(seed);
    await first.engine.reindex();
    expect((await first.engine.search({ query: "merlin" })).length).toBeGreaterThan(0);

    // Simulate the bump: the persisted cache carries a stale version number.
    const cacheFile = "Claude Code/Index/extracted.json";
    const parsed = JSON.parse(await first.adapter.read(cacheFile)) as { version: number };
    await first.adapter.write(cacheFile, JSON.stringify({ ...parsed, version: parsed.version - 1 }));

    // The "fixed" extractor produces different text for the same bytes.
    class FixedExtractor implements TextExtractor {
      readonly extensions = [".pdf"];
      async extract(): Promise<string | null> {
        return renderPdfMarkdown("doc", ["corrected gyrfalcon transcription"]);
      }
    }
    let t = 50_000;
    const engine2 = new EngramEngine(
      first.adapter,
      { ...DEFAULT_SETTINGS, indexAttachments: true },
      NULL_LOGGER,
      () => t++,
      { extractors: [new FixedExtractor()] },
    );
    expect(await engine2.loadIndex()).toBe(true); // adopts the stale chunks
    await engine2.refresh();
    expect((await engine2.search({ query: "gyrfalcon" })).length).toBeGreaterThan(0);
    expect((await engine2.search({ query: "merlin" })).length).toBe(0);
  });

  it("caches negative results so a no-text attachment is not re-parsed", async () => {
    const { adapter, engine, extractor } = makeEngine({});
    adapter.touch("Papers/scanned.pdf", "   "); // extractor yields null
    await engine.reindex();
    await engine.refresh();
    expect(extractor.calls).toBe(1); // null result cached by mtime
    expect(engine.getNoteChunks("Papers/scanned.pdf").length).toBe(0);
  });

  it("applies excluded-tag gating to extracted attachment text", async () => {
    const { engine } = makeEngine(
      { "Papers/tagged.pdf": "#confidential merlin sighting data" },
      { excludedTags: ["confidential"] },
    );
    await engine.reindex();
    expect((await engine.search({ query: "merlin sighting" })).length).toBe(0);
    expect(engine.getNoteChunks("Papers/tagged.pdf").length).toBe(0);
  });

  it("clears the extraction cache when the feature is turned off", async () => {
    const seed = { "Papers/doc.pdf": "harrier survey notes" };
    const { adapter, engine } = makeEngine(seed);
    await engine.reindex();
    expect(await adapter.read("Claude Code/Index/extracted.json")).toContain("harrier");

    engine.updateSettings({ ...DEFAULT_SETTINGS, indexAttachments: false });
    await engine.refresh();
    // Extracted text of possibly-sensitive PDFs must not be retained on disk.
    expect(await adapter.read("Claude Code/Index/extracted.json")).not.toContain("harrier");
    expect((await engine.search({ query: "harrier" })).length).toBe(0);
  });

  it("migrates a pre-v4 settings blob to indexAttachments=false", () => {
    const migrated = migrateSettings({ schemaVersion: 3, indexingEnabled: true });
    expect(migrated.indexAttachments).toBe(false);
  });
});

describe("CanvasExtractor (real, pure JSON)", () => {
  const extract = (obj: unknown) =>
    new CanvasExtractor().extract("Boards/plan.canvas", new TextEncoder().encode(JSON.stringify(obj)).buffer);

  it("renders text cards in reading order with groups, edge labels, and embeds", async () => {
    const md = await extract({
      nodes: [
        { id: "b", type: "text", text: "second card kingfisher", x: 0, y: 200 },
        { id: "a", type: "text", text: "first card cormorant", x: 0, y: 0 },
        { id: "g", type: "group", label: "Phase one", x: 0, y: 0 },
        { id: "f", type: "file", file: "Notes/spec.md", x: 50, y: 50 },
      ],
      edges: [{ fromNode: "a", toNode: "b", label: "leads to" }],
    });
    expect(md).toContain("# plan");
    expect(md).toContain("Groups: Phase one");
    expect(md!.indexOf("cormorant")).toBeLessThan(md!.indexOf("kingfisher")); // y-order
    expect(md).toContain("Connections: leads to");
    expect(md).toContain("Embedded files: Notes/spec.md");
  });

  it("returns null for empty canvases and invalid JSON", async () => {
    expect(await extract({ nodes: [], edges: [] })).toBeNull();
    expect(await extract({ nodes: [{ type: "file", file: "a.md" }] })).toBeNull(); // embeds alone aren't text
    const bad = new CanvasExtractor().extract("x.canvas", new TextEncoder().encode("{nope").buffer);
    expect(await bad).toBeNull();
  });

  it("indexes canvas cards end-to-end through the engine", async () => {
    const adapter = new InMemoryVaultAdapter("v", {
      "Boards/roadmap.canvas": JSON.stringify({
        nodes: [{ id: "1", type: "text", text: "ship the wagtail milestone next", x: 0, y: 0 }],
        edges: [],
      }),
    });
    let t = 10_000;
    const engine = new EngramEngine(
      adapter,
      { ...DEFAULT_SETTINGS, indexAttachments: true },
      NULL_LOGGER,
      () => t++,
      { extractors: [new CanvasExtractor()] },
    );
    await engine.reindex();
    const results = await engine.search({ query: "wagtail milestone" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.notePath).toBe("Boards/roadmap.canvas");
  });
});

describe("pdf markdown rendering (pure)", () => {
  it("renders one section per non-empty page and null when no page has text", () => {
    const md = renderPdfMarkdown("Report", ["intro text", "", "conclusion text"]);
    expect(md).toContain("# Report");
    expect(md).toContain("## Page 1\n\nintro text");
    expect(md).not.toContain("## Page 2\n\n\n");
    expect(md).toContain("## Page 3\n\nconclusion text");
    expect(renderPdfMarkdown("Empty", ["", "  "])).toBeNull();
  });

  it("joins pdf.js text items honoring hasEOL and collapsing blank runs", () => {
    const joined = joinPdfTextItems([
      { str: "first line", hasEOL: true },
      { str: "second " },
      { str: "line", hasEOL: true },
      { str: "", hasEOL: true },
      { str: "", hasEOL: true },
      { str: "after gap" },
    ]);
    expect(joined).toContain("first line\nsecond line");
    expect(joined).toContain("\n\nafter gap");
  });
});

describe("ExtractionCache", () => {
  it("round-trips entries, prunes dead paths, and persists only when dirty", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    const file = "Index/extracted.json";
    const cache = new ExtractionCache(adapter, file);
    await cache.load();
    cache.set("a.pdf", 100, "text a");
    cache.set("b.pdf", 200, null);
    await cache.persist();
    const mtimeAfterFirst = await adapter.getMtime(file);

    // Unchanged persist is a no-op write.
    await cache.persist();
    expect(await adapter.getMtime(file)).toBe(mtimeAfterFirst);

    const cache2 = new ExtractionCache(adapter, file);
    await cache2.load();
    expect(cache2.get("a.pdf", 100)?.text).toBe("text a");
    expect(cache2.get("a.pdf", 999)).toBeUndefined(); // mtime mismatch
    expect(cache2.get("b.pdf", 200)?.text).toBeNull(); // negative cache

    cache2.prune(new Set(["a.pdf"]));
    await cache2.persist();
    const cache3 = new ExtractionCache(adapter, file);
    await cache3.load();
    expect(cache3.get("b.pdf", 200)).toBeUndefined();
  });

  /**
   * `get` ignores an entry whose mtime does not match, which absorbs most
   * damage. What got past it was an entry with a matching mtime and a
   * non-string `text`: the refresh does `remainingChars -= entry.text.length`,
   * which is NaN, and every later `remainingChars <= 0` is then false — so one
   * corrupt entry silently switched off the corpus-wide attachment budget.
   * Cached `metadata` matters for the same reason: it feeds the tag-exclusion
   * check, which is a privacy control and must not depend on a cache file's
   * shape.
   */
  it("starts fresh rather than trusting malformed cached entries", async () => {
    const file = "Index/extracted.json";
    const wrapped = (entries: unknown) => JSON.stringify({ version: 2, entries });
    const goodMetadata = { tags: [], aliases: [], links: [], bodyStartLine: 0 };

    // The control: a well-formed file must still load.
    const adapter = new InMemoryVaultAdapter("v", {});
    await adapter.write(file, wrapped({ "a.pdf": { mtime: 5, text: "hello" } }));
    const healthy = new ExtractionCache(adapter, file);
    await healthy.load();
    expect(healthy.get("a.pdf", 5)?.text).toBe("hello");

    const corruptions: unknown[] = [
      { "a.pdf": null },
      { "a.pdf": 7 },
      { "a.pdf": { mtime: 5, text: 42 } },
      { "a.pdf": { mtime: 5, text: {} } },
      { "a.pdf": { mtime: "5", text: "hello" } },
      { "a.pdf": { mtime: 5, text: "hello", metadata: { tags: "work" } } },
      { "a.pdf": { mtime: 5, text: "hello", metadata: { ...goodMetadata, links: 7 } } },
      [{ mtime: 5, text: "hello" }],
      "nope",
    ];

    for (const entries of corruptions) {
      await adapter.write(file, wrapped(entries));
      const cache = new ExtractionCache(adapter, file);
      await cache.load();
      const label = JSON.stringify(entries).slice(0, 50);
      expect(cache.get("a.pdf", 5), `trusted a corrupt entry: ${label}`).toBeUndefined();
      // A discarded cache must also tell the caller to re-chunk, exactly as a
      // version bump does — otherwise the index keeps chunks derived from text
      // this load just refused.
      expect(cache.consumeReset(), `no reset signalled for: ${label}`).toBe(true);
    }
  });

  it("reports no skipped attachments for a corpus that fits, and clears the count when disabled", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    adapter.seedBinary("Data/small.txt", new TextEncoder().encode("kea field notes"));
    let t = 10_000;
    const settings = { ...DEFAULT_SETTINGS, indexAttachments: true };
    const engine = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++, {
      extractors: [new PlainTextExtractor()],
    });
    await engine.reindex();
    expect(engine.getIndexStats().skippedAttachments).toBe(0);

    engine.updateSettings({ ...settings, indexAttachments: false });
    await engine.reindex();
    expect(engine.getIndexStats().skippedAttachments).toBe(0);
  });

  it("reuses cached metadata instead of re-deriving it from the text each scan", async () => {
    // The attachment pass runs over EVERY attachment on every refresh, while
    // the markdown side is O(changed) — so deriving tags/links again for text
    // that did not change is the dominant cost of an incremental refresh.
    // Poisoning the cached metadata is the decisive proof it is trusted: the
    // text below has no tags at all, so an exclusion can only bite if the
    // cached value was used.
    const adapter = new InMemoryVaultAdapter("v", {});
    adapter.seedBinary("Data/a.txt", new TextEncoder().encode("kakapo quarterly report"));
    const cachePath = "Claude Code/Index/extracted.json";
    const build = (settings: Partial<EngramSettings>) => {
      let t = 10_000;
      return new EngramEngine(
        adapter,
        { ...DEFAULT_SETTINGS, indexAttachments: true, ...settings },
        NULL_LOGGER,
        () => t++,
        { extractors: [new PlainTextExtractor()] },
      );
    };

    await build({}).reindex();
    const cached = JSON.parse(await adapter.read(cachePath)) as {
      entries: Record<string, { metadata?: { tags: string[] } }>;
    };
    expect(cached.entries["Data/a.txt"].metadata?.tags).toEqual([]);

    cached.entries["Data/a.txt"].metadata = {
      tags: ["secret"],
      aliases: [],
      links: [],
      bodyStartLine: 0,
    } as never;
    await adapter.write(cachePath, JSON.stringify(cached));

    const excluded = build({ excludedTags: ["secret"] });
    await excluded.reindex();
    expect(excluded.getNoteChunks("Data/a.txt")).toEqual([]);
  });

  it("fills in metadata for a cache file written before it existed, without re-extracting", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    adapter.seedBinary("Data/b.txt", new TextEncoder().encode("takahe ledger"));
    const cachePath = "Claude Code/Index/extracted.json";
    let extractions = 0;
    const counting: TextExtractor = {
      extensions: [".txt"],
      async extract(path: string, data: ArrayBuffer) {
        extractions++;
        return `# ${path}\n\n${new TextDecoder().decode(data)}`;
      },
    };
    const build = () => {
      let t = 10_000;
      return new EngramEngine(
        adapter,
        { ...DEFAULT_SETTINGS, indexAttachments: true },
        NULL_LOGGER,
        () => t++,
        { extractors: [counting] },
      );
    };

    await build().reindex();
    expect(extractions).toBe(1);

    // Strip the field, as an older build would have left it.
    const stripped = JSON.parse(await adapter.read(cachePath)) as {
      entries: Record<string, { metadata?: unknown }>;
    };
    delete stripped.entries["Data/b.txt"].metadata;
    await adapter.write(cachePath, JSON.stringify(stripped));

    const engine = build();
    await engine.reindex();
    expect(engine.getNoteChunks("Data/b.txt").length).toBeGreaterThan(0);
    expect(extractions).toBe(1); // upgraded in place, not re-extracted
    const upgraded = JSON.parse(await adapter.read(cachePath)) as {
      entries: Record<string, { metadata?: unknown }>;
    };
    expect(upgraded.entries["Data/b.txt"].metadata).toBeDefined();
  });

  it("tolerates a corrupt cache file", async () => {
    const adapter = new InMemoryVaultAdapter("v", { "Index/extracted.json": "{not json" });
    const cache = new ExtractionCache(adapter, "Index/extracted.json");
    await cache.load();
    expect(cache.get("x.pdf", 1)).toBeUndefined();
  });
});

describe("extracted-text ceiling", () => {
  it("caps one attachment's text and says so, without inventing text for an empty result", async () => {
    // The 50 MB input cap bounds what is READ, not what comes back: a plain
    // text file yields text roughly its own size, and unbounded that becomes
    // tens of thousands of chunks from a single file.
    const adapter = new InMemoryVaultAdapter("v", {});
    const huge = "kokako ".repeat(400_000); // ~2.8 MB of text, well under the read cap
    adapter.seedBinary("Data/huge.txt", new TextEncoder().encode(huge));
    let t = 10_000;
    const engine = new EngramEngine(
      adapter,
      { ...DEFAULT_SETTINGS, indexAttachments: true },
      NULL_LOGGER,
      () => t++,
      { extractors: [new PlainTextExtractor()] },
    );
    await engine.reindex();

    const chunks = engine.getNoteChunks("Data/huge.txt");
    expect(chunks.length).toBeGreaterThan(0);
    const total = chunks.reduce((n, c) => n + c.text.length, 0);
    // Bounded by the ceiling (plus chunk overlap), not by the file's size.
    expect(total).toBeLessThan(1024 * 1024 * 1.5);
    expect(chunks.some((c) => c.text.includes("extraction truncated"))).toBe(true);
    // The file is still findable — truncation is not exclusion.
    expect((await engine.search({ query: "kokako" }))[0]?.chunk.notePath).toBe("Data/huge.txt");
  });

  it("skips an attachment larger than the read cap without reading it", async () => {
    // Extraction reads the whole file into memory, so the size cap is what
    // stops one enormous attachment from being read at all. The fixture really
    // is cap-sized — the filter reads `size` from the vault listing, so a
    // smaller stand-in would not exercise it.
    const adapter = new InMemoryVaultAdapter("v", {});
    adapter.seedBinary("Data/oversized.txt", new Uint8Array(ATTACHMENT_MAX_BYTES + 1));
    adapter.seedBinary("Data/ordinary.txt", new TextEncoder().encode("kokako field notes"));
    let reads = 0;
    const counting: TextExtractor = {
      extensions: [".txt"],
      async extract(path, data) {
        reads++;
        const text = new TextDecoder().decode(data).trim();
        return text ? `# ${path}\n\n${text}` : null;
      },
    };
    let t = 10_000;
    const engine = new EngramEngine(
      adapter,
      { ...DEFAULT_SETTINGS, indexAttachments: true },
      NULL_LOGGER,
      () => t++,
      { extractors: [counting] },
    );
    await engine.reindex();

    expect(engine.getNoteChunks("Data/oversized.txt")).toEqual([]);
    expect(engine.getNoteChunks("Data/ordinary.txt").length).toBeGreaterThan(0);
    // The oversized file was never handed to an extractor at all.
    expect(reads).toBe(1);
  });

  it("stops indexing attachments once the whole-corpus text budget is spent", async () => {
    // Per-file caps bound one document, not a thousand of them. Both the
    // extraction cache and the index are single JSON documents, and past
    // ~512 MB JSON.stringify throws RangeError — an abort, not a degradation.
    const adapter = new InMemoryVaultAdapter("v", {});
    const perFile = 1024 * 1024;
    const count = Math.ceil(ATTACHMENT_TEXT_BUDGET_CHARS / perFile) + 2;
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const path = `Data/f${String(i).padStart(3, "0")}.txt`;
      names.push(path);
      adapter.seedBinary(path, new Uint8Array([1]));
    }
    // Text is generated, not seeded, so the fixture costs one byte per file.
    const bulky: TextExtractor = {
      extensions: [".txt"],
      needsBytes: false,
      async extract(path: string) {
        return `# ${path}\n\n${"kakapo ".repeat(perFile / 7)}`;
      },
    };
    let t = 10_000;
    const engine = new EngramEngine(
      adapter,
      { ...DEFAULT_SETTINGS, indexAttachments: true },
      NULL_LOGGER,
      () => t++,
      { extractors: [bulky] },
    );
    await engine.reindex();

    expect(engine.getNoteChunks(names[0]).length).toBeGreaterThan(0);
    expect(engine.getNoteChunks(names[count - 1])).toEqual([]);
    const indexedChars = names.reduce(
      (n, p) => n + engine.getNoteChunks(p).reduce((m, c) => m + c.text.length, 0),
      0,
    );
    // Bounded by the budget (plus the one file that crosses it, plus chunk
    // overlap), not by how many attachments the vault holds.
    expect(indexedChars).toBeLessThan((ATTACHMENT_TEXT_BUDGET_CHARS + perFile) * 1.2);
    // The user can see it happened: a partial index nobody is told about reads
    // exactly like a document that simply will not match.
    expect(engine.getIndexStats().skippedAttachments).toBeGreaterThan(0);

    // Skipped files leave nothing behind in the extraction cache either.
    const cache = JSON.parse(await adapter.read("Claude Code/Index/extracted.json")) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(cache.entries)).not.toContain(names[count - 1]);
  });

  it("leaves a no-text attachment as no text, not as a truncation notice", async () => {
    const adapter = new InMemoryVaultAdapter("v", {});
    adapter.seedBinary("Data/empty.txt", new TextEncoder().encode("   \n  "));
    let t = 10_000;
    const engine = new EngramEngine(
      adapter,
      { ...DEFAULT_SETTINGS, indexAttachments: true },
      NULL_LOGGER,
      () => t++,
      { extractors: [new PlainTextExtractor()] },
    );
    await engine.reindex();
    expect(engine.getNoteChunks("Data/empty.txt")).toHaveLength(0);
  });
});
