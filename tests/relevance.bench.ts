/**
 * relevance.bench — golden-query relevance eval for the retrieval pipeline.
 *
 * Plants "needle" notes with known facts in a synthetic vault and asks queries
 * whose correct answer is unambiguous, reporting recall@8 and MRR per query
 * class. This is the measurement harness for ranking changes: tuning weights,
 * adding ranking signals (filename/alias/heading fields, morphology,
 * proximity), or changing chunking must move these numbers, not vibes.
 *
 * Query classes:
 *   body      — query terms appear in the needle's body text (BM25 baseline;
 *               should be ~perfect, asserted as a regression floor)
 *   filename  — terms appear ONLY in the needle note's filename
 *   heading   — terms appear ONLY in a section heading (not body text)
 *   alias     — terms appear ONLY in frontmatter aliases
 *   plural    — body uses one number form, the query uses the other
 *   phrase    — two notes share both query terms; only the needle has them
 *               adjacent (proximity signal; MRR-sensitive)
 *
 * Needle terms are invented words, so exactly one note (or two, for phrase)
 * can match — recall failures are ranking-signal gaps, not corpus accidents.
 *
 * NOT part of `npm test` / CI (like the scale bench). Run on demand:
 *   npm run eval
 *
 * Lexical-only: the bench's synthetic hash vectors measure vector COMPUTE
 * cost, not semantic quality, so a hybrid quality number here would be noise.
 */

import { describe, it, expect } from "vitest";
import { InMemoryVaultAdapter } from "../src/core/vault-adapter";
import { VaultScanner, ScanConfig } from "../src/indexing/vault-scanner";
import { IndexManager } from "../src/indexing/index-manager";
import { LexicalRetriever } from "../src/retrieval/lexical-retriever";

const RECALL_LIMIT = 8;

/** mulberry32 — deterministic PRNG so the corpus is reproducible. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Background vocabulary — deliberately disjoint from every needle term below.
const NOISE_VOCAB = [
  "meeting", "sprint", "deploy", "review", "ticket", "backlog", "release",
  "standup", "roadmap", "estimate", "incident", "oncall", "retro", "budget",
  "quarter", "hiring", "design", "draft", "feedback", "metric", "dashboard",
  "alert", "runbook", "postmortem", "vendor", "contract", "invoice", "travel",
];

function noiseWords(rng: () => number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(NOISE_VOCAB[Math.floor(rng() * NOISE_VOCAB.length)]);
  return out.join(" ");
}

interface GoldenQuery {
  cls: string;
  query: string;
  /** The note that MUST come back (vault-relative path). */
  needle: string;
}

/** Build the corpus: noise notes + one needle per golden query. */
function buildVault(): { seed: Record<string, string>; queries: GoldenQuery[] } {
  const rng = makeRng(0xc0de);
  const seed: Record<string, string> = {};
  const queries: GoldenQuery[] = [];

  for (let i = 0; i < 200; i++) {
    seed[`Notes/noise-${i}.md`] = `# Note ${i}\n\n${noiseWords(rng, 60)}\n\n## Detail\n\n${noiseWords(rng, 60)}\n`;
  }

  const body = (fact: string) => `${noiseWords(rng, 25)} ${fact} ${noiseWords(rng, 25)}`;

  // body — terms in body text (baseline; invented words, df=1).
  const bodyNeedles: Array<[string, string]> = [
    ["zephyrite migration plan", "the zephyrite migration plan was approved"],
    ["cobaltine rollback threshold", "set the cobaltine rollback threshold to nine"],
    ["marrowick cache invalidation", "marrowick cache invalidation happens nightly"],
    ["thornbury auth handshake", "the thornbury auth handshake uses mutual keys"],
    ["veldspar quota ceiling", "raised the veldspar quota ceiling last week"],
    ["glimmerfen retry allotment", "the glimmerfen retry allotment is three attempts"],
  ];
  bodyNeedles.forEach(([q, fact], i) => {
    const path = `Projects/body-${i}.md`;
    seed[path] = `# Working notes ${i}\n\n${body(fact)}\n`;
    queries.push({ cls: "body", query: q, needle: path });
  });

  // filename — terms ONLY in the note's filename.
  const fileNeedles = [
    "Quartzine Protocol", "Ambervale Checklist", "Duskmere Playbook",
    "Fennelgrove Charter", "Ironquill Standards", "Lanternfell Runsheet",
  ];
  fileNeedles.forEach((name, i) => {
    const path = `Reference/${name}.md`;
    seed[path] = `# Reference ${i}\n\n${noiseWords(rng, 50)}\n`;
    queries.push({ cls: "filename", query: name.toLowerCase(), needle: path });
  });

  // heading — terms ONLY in a section heading.
  const headingNeedles = [
    "starfall rotation", "mosswick escalation", "pinecrest triage",
    "wintersedge cadence", "foxglove handover", "elmsworth freeze",
  ];
  headingNeedles.forEach((h, i) => {
    const path = `Ops/heading-${i}.md`;
    seed[path] = `# Ops note ${i}\n\n${noiseWords(rng, 30)}\n\n## ${h}\n\n${noiseWords(rng, 30)}\n`;
    queries.push({ cls: "heading", query: h, needle: path });
  });

  // alias — terms ONLY in frontmatter aliases.
  const aliasNeedles = ["bramblewood", "cinderpath", "hollowbrook", "nightvale", "saltmarsh", "thistledown"];
  aliasNeedles.forEach((a, i) => {
    const path = `Areas/alias-${i}.md`;
    seed[path] = `---\naliases: [${a}]\n---\n\n# Area ${i}\n\n${noiseWords(rng, 50)}\n`;
    queries.push({ cls: "alias", query: a, needle: path });
  });

  // plural — body uses one number form, query the other.
  const pluralNeedles: Array<[string, string]> = [
    ["grimstone decisions", "the grimstone decision was recorded here"],
    ["copperline token", "copperline tokens rotate every hour"],
    ["willowmarsh policies", "the willowmarsh policy covers backups"],
    ["ravenshollow migration", "ravenshollow migrations run in batches"],
    ["stonewick constraint", "stonewick constraints apply to exports"],
    ["ashenfield reviews", "each ashenfield review takes an hour"],
  ];
  pluralNeedles.forEach(([q, fact], i) => {
    const path = `Projects/plural-${i}.md`;
    seed[path] = `# Working notes p${i}\n\n${body(fact)}\n`;
    queries.push({ cls: "plural", query: q, needle: path });
  });

  // phrase — decoy contains both terms far apart; needle has them adjacent.
  const phraseNeedles = [
    "crimson ledger", "silver harbor", "grimshaw gate",
    "velvet anchor", "copper lantern", "marble compass",
  ];
  phraseNeedles.forEach((phrase, i) => {
    const [a, b] = phrase.split(" ");
    const needle = `Phrases/phrase-${i}.md`;
    const decoy = `Phrases/decoy-${i}.md`;
    seed[needle] = `# Phrase note ${i}\n\nthe ${phrase} process is documented ${noiseWords(rng, 40)}\n`;
    seed[decoy] = `# Decoy note ${i}\n\nthe ${a} report ${noiseWords(rng, 40)} filed under ${b} storage\n`;
    queries.push({ cls: "phrase", query: phrase, needle });
  });

  return { seed, queries };
}

const SCAN: ScanConfig = { includedFolders: [], excludedFolders: [], excludedTags: [], excludedPathPatterns: [] };

describe("relevance eval (lexical, golden queries)", () => {
  it("reports recall@8 and MRR per query class", async () => {
    const { seed, queries } = buildVault();
    const adapter = new InMemoryVaultAdapter("v", seed);
    const scanner = new VaultScanner(adapter);
    const im = new IndexManager(adapter, {
      chunksFile: "Index/chunks.json",
      metadataFile: "Index/metadata.json",
      embeddingsFile: "Index/embeddings.json",
    });
    im.build(await scanner.scan(SCAN));
    const chunks = im.getChunks();
    const retriever = new LexicalRetriever();

    // Every needle must actually be indexed, or the eval measures nothing.
    for (const q of queries) {
      expect(chunks.some((c) => c.notePath === q.needle), `needle indexed: ${q.needle}`).toBe(true);
    }

    const perClass = new Map<string, { n: number; hits: number; rr: number }>();
    for (const q of queries) {
      const results = retriever.retrieve({ query: q.query, limit: RECALL_LIMIT }, chunks);
      const rank = results.findIndex((r) => r.chunk.notePath === q.needle);
      const agg = perClass.get(q.cls) ?? { n: 0, hits: 0, rr: 0 };
      agg.n++;
      if (rank >= 0) {
        agg.hits++;
        agg.rr += 1 / (rank + 1);
      }
      perClass.set(q.cls, agg);
    }

    console.log("\n===== relevance eval (lexical, recall@8 / MRR) =====");
    console.log("class      queries  recall@8   MRR");
    for (const [cls, a] of perClass) {
      console.log(
        `${cls.padEnd(10)} ${String(a.n).padStart(7)}  ${(a.hits / a.n).toFixed(2).padStart(8)}  ${(a.rr / a.n).toFixed(2).padStart(4)}`,
      );
    }
    console.log("====================================================\n");

    // Regression floors only — deliberately loose. The harness is a
    // measurement tool; hard-coding today's exact numbers would make every
    // intentional ranking change a test failure.
    const floor = (cls: string, min: number) => {
      const a = perClass.get(cls)!;
      expect(a.hits / a.n, `recall@8 floor for ${cls}`).toBeGreaterThanOrEqual(min);
    };
    floor("body", 0.9);
    // Field matching (filename + aliases) shipped with this harness; both
    // classes went 0.00 → 1.00 and use invented terms, so a high floor is safe.
    floor("filename", 0.9);
    floor("alias", 0.9);
  }, 120_000);
});
