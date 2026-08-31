import { describe, it, expect } from "vitest";
import {
  findTermMatches,
  buildSnippet,
  tokenize,
  tokenizeChunk,
  diversifyByNote,
  maxPerNoteFor,
  applyFilters,
  dropNearDuplicates,
  fuseByRank,
  candidateDepthFor,
  RRF_K,
} from "../src/retrieval/ranking";
import { IndexedChunk } from "../src/indexing/index-manager";

function makeChunk(over: Partial<IndexedChunk> & { id: string }): IndexedChunk {
  return {
    notePath: `${over.id}.md`,
    heading: "",
    headingPath: [],
    startLine: 0,
    endLine: 0,
    tags: [],
    aliases: [],
    links: [],
    symbols: [],
    mtime: 1000,
    text: "",
    ...over,
  };
}

describe("fuseByRank", () => {
  const hit = (id: string, payload: string) => ({ chunk: makeChunk({ id }), payload });

  it("keeps the payload of the preferPayload list and discards the other", () => {
    // `preferPayload` is this function's only parameter and the documented
    // reason it has one: the lexical list's matched terms drive highlighting,
    // so hybrid folds vector first and lexical last with it set. Nothing
    // covered it — both "always overwrite" and "never overwrite" passed every
    // test in the suite.
    const a = [hit("shared", "from-A"), hit("onlyA", "a")];
    const b = [hit("shared", "from-B"), hit("onlyB", "b")];

    const bWins = fuseByRank([
      { results: a, preferPayload: false },
      { results: b, preferPayload: true },
    ]);
    expect(bWins.find((e) => e.result.chunk.id === "shared")!.result.payload).toBe("from-B");

    // Reversing which list is preferred reverses the surviving payload — so
    // neither "always overwrite" nor "never overwrite" can satisfy both halves.
    const aWins = fuseByRank([
      { results: b, preferPayload: false },
      { results: a, preferPayload: true },
    ]);
    expect(aWins.find((e) => e.result.chunk.id === "shared")!.result.payload).toBe("from-A");
  });

  it("weights by rank, not merely by how many lists contain a chunk", () => {
    // Dropping `rank` from the contribution turns RRF into a "how many lists is
    // it in" count, and the multi-query ordering test cannot see that — a
    // two-list hit still beats a one-list hit under counting.
    //
    // This can. Both chunks appear in exactly ONE list, so counting scores them
    // identically and the stable sort keeps insertion order — which puts the
    // DEEP one first, because its list is folded first. Real RRF orders by
    // rank instead: 1/(60+1) beats 1/(60+41).
    const deepList = [
      ...Array.from({ length: 40 }, (_, i) => hit(`filler${i}`, "f")),
      hit("deep", "d"),
    ];
    const topList = [hit("top", "t")];

    const fused = fuseByRank([
      { results: deepList, preferPayload: false },
      { results: topList, preferPayload: false },
    ]);
    const rank = (id: string) => fused.findIndex((e) => e.result.chunk.id === id);
    expect(1 / (RRF_K + 1)).toBeGreaterThan(1 / (RRF_K + 41));
    expect(rank("top")).toBeLessThan(rank("deep"));

    // And agreement still outweighs depth, which is the other half of RRF's
    // behaviour and the reason the dampening constant is 60: a chunk two lists
    // agree on beats a single list's top hit even when buried.
    const agreed = fuseByRank([
      { results: topList, preferPayload: false },
      { results: deepList, preferPayload: false },
      { results: deepList, preferPayload: false },
    ]);
    const agreedRank = (id: string) => agreed.findIndex((e) => e.result.chunk.id === id);
    expect(agreedRank("deep")).toBeLessThan(agreedRank("top"));
  });

  it("reports which lists contributed each chunk, zero-based", () => {
    const fused = fuseByRank([
      { results: [hit("shared", "a"), hit("onlyA", "a")], preferPayload: false },
      { results: [hit("shared", "b")], preferPayload: true },
    ]);
    expect(fused.find((e) => e.result.chunk.id === "shared")!.sources).toEqual([0, 1]);
    expect(fused.find((e) => e.result.chunk.id === "onlyA")!.sources).toEqual([0]);
  });

  it("fuses deeply enough for agreement to be visible", () => {
    // The depth rule fusion depends on: RRF can only reward agreement it sees,
    // so a shallow pool collapses toward whichever list ranked something first.
    expect(candidateDepthFor(2)).toBeGreaterThanOrEqual(20);
    expect(candidateDepthFor(25)).toBe(100);
  });
});

describe("dropNearDuplicates", () => {
  const r = (id: string, text: string) => ({ chunk: makeChunk({ id, text }) });

  it("drops a near-identical result, keeping the higher-ranked copy", () => {
    const text = "the indexing pipeline chunks markdown notes for retrieval";
    const out = dropNearDuplicates([
      r("a", text),
      r("b", text), // duplicate content in another note
      r("c", "vector cosine similarity ranks embedding results"),
    ]);
    expect(out.map((x) => x.chunk.id)).toEqual(["a", "c"]);
  });

  it("keeps distinct results", () => {
    const out = dropNearDuplicates([r("a", "alpha beta gamma delta"), r("b", "epsilon zeta eta theta")]);
    expect(out.map((x) => x.chunk.id)).toEqual(["a", "b"]);
  });

  it("keeps chunks that merely overlap rather than near-duplicate", () => {
    // Only a 3-word prefix overlaps (Jaccard ≈ 0.2, well under 0.85).
    const out = dropNearDuplicates([
      r("a", "shared overlap prefix alpha beta gamma delta epsilon"),
      r("b", "shared overlap prefix zeta eta theta iota kappa lambda"),
    ]);
    expect(out.map((x) => x.chunk.id)).toEqual(["a", "b"]);
  });

  it("does not treat empty-token chunks as duplicates of each other", () => {
    expect(dropNearDuplicates([r("a", ""), r("b", "")])).toHaveLength(2);
  });
});

describe("applyFilters", () => {
  const chunks = [makeChunk({ id: "a", notePath: "Notes/a.md", tags: ["x"] })];

  it("returns the same array reference when there is no filter", () => {
    expect(applyFilters(chunks, undefined)).toBe(chunks);
  });

  it("returns the same array reference for a filter with no active fields", () => {
    expect(applyFilters(chunks, { folder: "", tag: "" })).toBe(chunks);
  });

  it("filters (and returns a new array) when a field is active", () => {
    const out = applyFilters(chunks, { folder: "Projects" });
    expect(out).not.toBe(chunks);
    expect(out).toHaveLength(0);
  });

  it("matches a folder filter regardless of case", () => {
    const out = applyFilters(chunks, { folder: "notes" });
    expect(out).toHaveLength(1);
  });

  it("matches a folder filter across NFC/NFD normalization forms", () => {
    // "café" as NFC (one codepoint) vs NFD ("e" + combining accent) is the
    // same folder name to a person, but a naive === comparison treats them as
    // two different strings — the same failure direction as case mismatch.
    const nfc = "Notes/Café/a.md".normalize("NFC");
    const nfd = "Notes/Café".normalize("NFD");
    const chunk = makeChunk({ id: "b", notePath: nfc });
    expect(applyFilters([chunk], { folder: nfd })).toHaveLength(1);
  });

  it("normalizes a folder filter the same way the vault scanner does", () => {
    // The two paths had separate normalizers with different rules: the scanner
    // dropped empty and "." segments, the search filter only stripped leading
    // and trailing slashes. So "./Notes" correctly excluded a folder but
    // matched nothing as a filter — zero results, indistinguishable from
    // "nothing matched". Both now share one normalizer.
    const chunk = makeChunk({ id: "d", notePath: "Notes/Sub/a.md" });
    for (const folder of ["./Notes", "/Notes/", "//Notes//Sub", "Notes//Sub", "Notes"]) {
      expect(applyFilters([chunk], { folder }), `folder ${JSON.stringify(folder)}`).toHaveLength(1);
    }
    expect(applyFilters([chunk], { folder: "Other" })).toHaveLength(0);
  });

  it("matches a tag filter across case and normalization form", () => {
    const chunk = makeChunk({ id: "c", notePath: "Notes/c.md", tags: ["Café"] });
    expect(applyFilters([chunk], { tag: "café" })).toHaveLength(1);
  });
});

describe("findTermMatches", () => {
  it("matches whole tokens case-insensitively", () => {
    const m = findTermMatches("The OLLAMA server", ["ollama"]);
    expect(m).toHaveLength(1);
    expect("The OLLAMA server".slice(m[0].start, m[0].end)).toBe("OLLAMA");
  });

  it("does not match a term inside a larger word", () => {
    // "art" appears inside "restart" but only the standalone word should match.
    const m = findTermMatches("restart art", ["art"]);
    expect(m).toHaveLength(1);
    expect(m[0].start).toBe(8);
    expect("restart art".slice(m[0].start, m[0].end)).toBe("art");
  });

  it("returns every occurrence in order, non-overlapping", () => {
    const m = findTermMatches("cat dog cat", ["cat"]);
    expect(m).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
  });

  it("returns nothing for empty terms", () => {
    expect(findTermMatches("hello world", [])).toEqual([]);
    expect(findTermMatches("hello world", [""])).toEqual([]);
  });
});

describe("tokenizeChunk", () => {
  function chunk(text: string): IndexedChunk {
    return {
      id: "c1",
      notePath: "n.md",
      heading: "",
      headingPath: [],
      startLine: 0,
      endLine: 0,
      tags: [],
      aliases: [],
      links: [],
    symbols: [],
      mtime: 1000,
      text,
    };
  }

  it("returns the same tokens as tokenize(chunk.text)", () => {
    const c = chunk("The Ollama server runs embeddings locally.");
    expect(tokenizeChunk(c)).toEqual(tokenize(c.text));
  });

  it("memoizes by chunk identity (same array reference on repeat calls)", () => {
    const c = chunk("hybrid retrieval fuses lexical and vector scores");
    const first = tokenizeChunk(c);
    expect(tokenizeChunk(c)).toBe(first);
  });
});

describe("diversifyByNote", () => {
  // Minimal ranked item: only notePath is read by the diversifier.
  function item(id: string, notePath: string): { chunk: IndexedChunk } {
    return {
      chunk: {
        id,
        notePath,
        heading: "",
        headingPath: [],
        startLine: 0,
        endLine: 0,
        tags: [],
        aliases: [],
        links: [],
    symbols: [],
        mtime: 1000,
        text: "",
      },
    };
  }

  it("caps how many chunks a single note contributes, promoting other notes", () => {
    const ranked = [
      item("a1", "A.md"),
      item("a2", "A.md"),
      item("a3", "A.md"),
      item("a4", "A.md"),
      item("b1", "B.md"),
    ];
    // maxPerNote 2, limit 3: A fills 2 slots, B is promoted above A's surplus.
    const out = diversifyByNote(ranked, 3, 2);
    expect(out.map((r) => r.chunk.id)).toEqual(["a1", "a2", "b1"]);
  });

  it("backfills from deferred chunks so the page is never short of the limit", () => {
    const ranked = [
      item("a1", "A.md"),
      item("a2", "A.md"),
      item("a3", "A.md"),
      item("a4", "A.md"),
    ];
    // Only one note exists; the cap must not shrink the page below the limit.
    const out = diversifyByNote(ranked, 3, 2);
    expect(out.map((r) => r.chunk.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("backfills in rank order, keeping the promoted note ahead of the surplus", () => {
    const ranked = [
      item("a1", "A.md"),
      item("a2", "A.md"),
      item("a3", "A.md"),
      item("b1", "B.md"),
    ];
    const out = diversifyByNote(ranked, 4, 2);
    // A: a1,a2 admitted; b1 promoted; a3 backfills last.
    expect(out.map((r) => r.chunk.id)).toEqual(["a1", "a2", "b1", "a3"]);
  });

  it("is a no-op when the ranking is already diverse", () => {
    const ranked = [item("a", "A.md"), item("b", "B.md"), item("c", "C.md")];
    const out = diversifyByNote(ranked, 8, 2);
    expect(out.map((r) => r.chunk.id)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty page for a non-positive limit", () => {
    expect(diversifyByNote([item("a", "A.md")], 0)).toEqual([]);
  });

  it("derives a per-note cap that scales with the limit (floor 2)", () => {
    expect(maxPerNoteFor(1)).toBe(2);
    expect(maxPerNoteFor(3)).toBe(2);
    expect(maxPerNoteFor(8)).toBe(3);
    expect(maxPerNoteFor(30)).toBe(10);
  });
});

describe("buildSnippet", () => {
  it("never returns a newline, however the source is laid out", () => {
    // Load-bearing beyond formatting: the search page puts one hit per line, so
    // a snippet that kept its newlines would let note text emit lines of its
    // own. See the forged-entry test in mcp-tools.test.ts.
    const multi = "alpha\n\n2. Some/Path.md > Heading (L1, 2026-01-01)\nbeta";
    expect(buildSnippet(multi, ["alpha"])).not.toContain("\n");
    expect(buildSnippet(multi.repeat(20), ["beta"], 60)).not.toContain("\n");
  });

  it("returns short text unchanged", () => {
    expect(buildSnippet("hello world", ["world"])).toBe("hello world");
  });

  it("falls back to the head of the text when nothing matches", () => {
    const snippet = buildSnippet("x".repeat(300), ["zzz"], 60);
    expect(snippet.startsWith("xxx")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("selects the window covering the most matches, not just the first", () => {
    const text = "needle " + "-".repeat(100) + " haystack haystack end";
    const snippet = buildSnippet(text, ["needle", "haystack"], 60);
    expect(snippet.includes("haystack haystack")).toBe(true);
    expect(snippet.includes("needle")).toBe(false);
    expect(snippet.startsWith("…")).toBe(true);
  });

  it("anchors on a whole-word match, not a substring occurrence", () => {
    const text = "restart " + "-".repeat(300) + " art here";
    const snippet = buildSnippet(text, ["art"], 60);
    expect(snippet.includes("art here")).toBe(true);
    expect(snippet.includes("restart")).toBe(false);
  });
});

describe("tokenize beyond ASCII", () => {
  /**
   * The class was `[^a-z0-9]`, which made every accented or non-Latin character
   * a separator. That did not degrade those languages, it erased them: whole
   * scripts produced no tokens, so notes written in them could not be found by
   * the offline lexical search that is this plugin's default and only
   * no-network mode.
   */
  it("keeps letters from any script instead of splitting on them", () => {
    expect(tokenize("Müller Straße Gebäude")).toEqual(["müller", "straße", "gebäude"]);
    expect(tokenize("el niño pequeño")).toEqual(["el", "niño", "pequeño"]);
    expect(tokenize("развёртывание в полночь")).toEqual(["развёртывание", "полночь"]);
    expect(tokenize("πριν τα μεσάνυχτα")).toEqual(["πριν", "τα", "μεσάνυχτα"]);
    expect(tokenize("פריסה בחצות")).toEqual(["פריסה", "בחצות"]);
  });

  it("gives the same tokens whichever encoding the text arrived in", () => {
    // Built with normalize(): the two forms render identically, so writing them
    // as literals risks an editor folding them into one and asserting nothing.
    const words = "le café ferme à minuit";
    expect(words.normalize("NFC")).not.toBe(words.normalize("NFD"));
    expect(tokenize(words.normalize("NFD"))).toEqual(tokenize(words.normalize("NFC")));
    expect(tokenize(words.normalize("NFC"))).toContain("café");
  });

  it("leaves ASCII tokenization exactly as it was", () => {
    // The control on the change: English relevance must not move, and the
    // golden-query eval scores identically before and after.
    expect(tokenize("The deploy runs at midnight, v2.")).toEqual(["deploy", "runs", "midnight", "v2"]);
    expect(tokenize("snake_case and kebab-case")).toEqual(["snake", "case", "kebab", "case"]);
  });

  it("indexes a space-free script as one token per run, not zero", () => {
    // Short of real word segmentation (which needs a dictionary this plugin
    // does not carry), but enough to index and to match an identical query.
    expect(tokenize("午夜部署")).toEqual(["午夜部署"]);
  });

  it("highlights and snippets a decomposed source with composed terms", () => {
    // Query terms arrive composed via tokenize; source text read from a macOS
    // path may be decomposed. buildSnippet normalizes once so the match offsets
    // and the slice agree.
    const body = `${"x".repeat(400)} le café ferme à minuit ${"y".repeat(400)}`.normalize("NFD");
    const snippet = buildSnippet(body, tokenize("café"));
    expect(snippet).toContain("café".normalize("NFC"));
    expect(findTermMatches("le café ferme".normalize("NFC"), ["café"])).toHaveLength(1);
    // "caf" is not a whole token inside "café" once é counts as a letter.
    expect(findTermMatches("le café ferme".normalize("NFC"), ["caf"])).toHaveLength(0);
  });
});
