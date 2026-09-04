import { describe, it, expect } from "vitest";
import { EngramEngine } from "../src/engine";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { DEFAULT_SETTINGS, EngramSettings } from "../src/settings/settings";
import { NULL_LOGGER } from "../src/utils/logger";
import { selectSentences } from "../src/summarize/extractive";
import { cosineSimilarity } from "../src/embeddings/embedding-provider";
import { ConfigError } from "../src/utils/errors";
import { FakeHttpClient } from "../src/core/http-client";

const NOTE = `# Alpha Note
The indexing pipeline chunks markdown notes for retrieval.
Embeddings power the vector retriever when a provider is set.
The review inbox keeps human-in-the-loop control over memory.
Extractive summaries reuse the note's own sentences.`;

function makeEngine(
  seed: Record<string, string>,
  overrides: Partial<EngramSettings> = {},
  deps: ConstructorParameters<typeof EngramEngine>[4] = {},
) {
  const adapter = new InMemoryVaultAdapter("v", seed);
  const settings: EngramSettings = { ...DEFAULT_SETTINGS, ...overrides };
  let t = 10_000;
  const engine = new EngramEngine(adapter, settings, NULL_LOGGER, () => t++, deps);
  return { adapter, engine };
}

describe("EngramEngine.getNoteChunks", () => {
  it("returns chunks for an indexed note and [] for an unindexed one", async () => {
    const { engine } = makeEngine({ "Notes/a.md": NOTE });
    await engine.reindex();
    expect(engine.getNoteChunks("Notes/a.md").length).toBeGreaterThan(0);
    expect(engine.getNoteChunks("Notes/missing.md")).toEqual([]);
  });

  it("serves fresh chunks after an edit and refresh (per-note memo invalidates)", async () => {
    const { adapter, engine } = makeEngine({ "Notes/a.md": NOTE });
    await engine.reindex();
    // Prime the memoized per-note lookup, then change the note underneath it.
    expect(engine.getNoteChunks("Notes/a.md")[0].text).toContain("indexing pipeline");
    await adapter.write("Notes/a.md", "# Alpha Note\nA completely new body about caching.");
    await engine.refresh();
    const after = engine.getNoteChunks("Notes/a.md");
    expect(after.some((c) => c.text.includes("completely new body"))).toBe(true);
    expect(after.some((c) => c.text.includes("indexing pipeline"))).toBe(false);
  });
});

describe("EngramEngine.summarizeNote", () => {
  it("summarizes an indexed note", async () => {
    const { engine } = makeEngine({ "Notes/a.md": NOTE });
    await engine.reindex();
    const summary = await engine.summarizeNote("Notes/a.md");
    expect(summary.notePath).toBe("Notes/a.md");
    expect(summary.sentences.length).toBeGreaterThan(0);
    expect(summary.totalUnits).toBeGreaterThan(0);
    expect(summary.chunkCount).toBeGreaterThan(0);
    expect(summary.truncated).toBe(false);
    expect(["lexical", "embedding"]).toContain(summary.method);
  });

  it("feeds at most SUMMARY_MAX_UNITS sentences into the summarizer", async () => {
    // The cap bounds the WORK one call can trigger: with an embedding provider
    // configured every unit becomes a vector, so an enormous note would
    // otherwise turn one summarize into hundreds of embeddings. `totalUnits`
    // reports the bounded count, which is what makes the cap observable —
    // `truncated` alone would still be true with the cap removed.
    const lines = Array.from(
      { length: 280 },
      (_, i) => `Line ${i} concerns topic${i} and nothing else whatsoever.`,
    );
    const { engine } = makeEngine({ "Notes/big.md": `# Big\n${lines.join("\n")}` });
    await engine.reindex();

    const summary = await engine.summarizeNote("Notes/big.md", { maxSentences: 5 });
    expect(summary.truncated).toBe(true);
    expect(summary.totalUnits).toBe(200); // SUMMARY_MAX_UNITS
  });

  it("rejects a nonexistent (unindexed) path", async () => {
    const { engine } = makeEngine({ "Notes/a.md": NOTE });
    await engine.reindex();
    await expect(engine.summarizeNote("Notes/missing.md")).rejects.toBeInstanceOf(ConfigError);
  });

  it("rejects a note in an excluded folder", async () => {
    const { engine } = makeEngine(
      { "Notes/a.md": NOTE, "Private/secret.md": NOTE },
      { excludedFolders: ["Private"] },
    );
    await engine.reindex();
    expect(engine.getNoteChunks("Private/secret.md")).toEqual([]);
    await expect(engine.summarizeNote("Private/secret.md")).rejects.toBeInstanceOf(ConfigError);
  });

  it("uses the embedding method with a mock provider", async () => {
    const { engine } = makeEngine({ "Notes/a.md": NOTE }, { embeddingProvider: "mock" });
    await engine.reindex();
    const summary = await engine.summarizeNote("Notes/a.md");
    expect(summary.method).toBe("embedding");
  });

  it("uses the lexical method with no provider", async () => {
    const { engine } = makeEngine({ "Notes/a.md": NOTE }, { embeddingProvider: "none" });
    await engine.reindex();
    const summary = await engine.summarizeNote("Notes/a.md");
    expect(summary.method).toBe("lexical");
  });

  it("falls back to lexical when a configured provider is reachable but fails mid-call", async () => {
    // The documented guarantee is that summarize_note "fails open to lexical".
    // The no-provider path was covered; this is the other one — the provider
    // answers its liveness check, then throws on the embed call. Without the
    // catch this rejects and the tool returns an error instead of a summary.
    const endpoint = "http://127.0.0.1:11434";
    const http = new FakeHttpClient();
    http.onExact("GET", `${endpoint}/api/tags`, () => ({ status: 200, body: "{}" }));
    http.onExact("POST", `${endpoint}/api/embed`, () => {
      throw new Error("connection reset mid-request");
    });
    const { engine } = makeEngine(
      { "Notes/a.md": NOTE },
      { embeddingProvider: "ollama", embeddingModel: "nomic", embeddingEndpoint: endpoint },
      { http },
    );
    await engine.reindex();
    const summary = await engine.summarizeNote("Notes/a.md");
    expect(summary.method).toBe("lexical");
    expect(summary.sentences.length).toBeGreaterThan(0);
    // Not vacuous: the provider really was consulted and really did throw, so
    // this is the catch branch rather than the "no provider configured" one.
    expect(http.calls.some((c) => c.url.endsWith("/api/embed"))).toBe(true);
  });

  it("clamps maxSentences (0 -> at least 1, huge -> capped at available)", async () => {
    const { engine } = makeEngine({ "Notes/a.md": NOTE });
    await engine.reindex();

    const low = await engine.summarizeNote("Notes/a.md", { maxSentences: 0 });
    expect(low.sentences.length).toBeGreaterThanOrEqual(1);

    const high = await engine.summarizeNote("Notes/a.md", { maxSentences: 999 });
    expect(high.sentences.length).toBeLessThanOrEqual(Math.min(20, high.totalUnits));
    expect(high.sentences.length).toBe(high.totalUnits); // fewer than 20 units -> all returned
  });

  it("does not repeat the exact same sentence", async () => {
    const { engine } = makeEngine({ "Notes/a.md": NOTE });
    await engine.reindex();
    const summary = await engine.summarizeNote("Notes/a.md", { maxSentences: 20 });
    expect(new Set(summary.sentences).size).toBe(summary.sentences.length);
  });
});

describe("MMR selection carries its similarities between rounds", () => {
  it("picks exactly what recomputing every pair would have picked", () => {
    // The selection loop recomputed each candidate's similarity to every
    // already-selected sentence on every round — n x want^2/2 cosines where
    // n x want do, because a maximum is associative. This pins the OUTPUT so
    // the cheaper form can never quietly become a different summarizer:
    // reference below is the original nested-loop rule, written out.
    let seed = 7;
    const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const n = 60;
    const dim = 16;
    const units = Array.from({ length: n }, (_, i) => `s${i}`);
    const scores = units.map(() => rng());
    const vectors = units.map(() => Array.from({ length: dim }, () => rng() * 2 - 1));

    const reference = (want: number): number[] => {
      const lambda = 0.7;
      const selected: number[] = [];
      const remaining = new Set(units.map((_, i) => i));
      while (selected.length < want && remaining.size > 0) {
        let best = -1;
        let bestVal = -Infinity;
        for (const i of remaining) {
          let maxSim = 0;
          for (const j of selected) {
            const sim = cosineSimilarity(vectors[i], vectors[j]);
            if (sim > maxSim) maxSim = sim;
          }
          const val = lambda * scores[i] - (1 - lambda) * maxSim;
          if (val > bestVal || (val === bestVal && (best < 0 || i < best))) {
            bestVal = val;
            best = i;
          }
        }
        if (best < 0) break;
        selected.push(best);
        remaining.delete(best);
      }
      return selected.sort((a, b) => a - b);
    };

    for (const want of [1, 3, 8, 20, n]) {
      expect(selectSentences(units, scores, want, { vectors }), `want=${want}`)
        .toEqual(reference(want));
    }
  });
});
