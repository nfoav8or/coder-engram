/**
 * relevance.bench — golden-query relevance eval for the retrieval pipeline.
 *
 * Plants "needle" notes with known facts in a synthetic vault and asks queries
 * whose correct answer is unambiguous, reporting recall@8 and MRR per query
 * class. This is the measurement harness for ranking changes: tuning weights,
 * adding ranking signals (filename/alias/heading fields, morphology,
 * proximity), or changing chunking must move these numbers, not vibes.
 *
 * A second section measures the OTHER half of retrieval quality — what an
 * answer costs in context. Finding the note is only half the job; the agent
 * pays for every character the result page carries. It reports, per class,
 * the page size, how much of it is locator overhead rather than content, and
 * the chars read before reaching the needle. Changes to snippet width, dedup,
 * the per-note cap, or the result format must move these numbers, not vibes.
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
import { dropNearDuplicates, diversifyByNote } from "../src/retrieval/ranking";

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

  // longnote — the needle fact sits inside a note far longer than one chunk, so
  // the answer depends on how the section was windowed. Every other class uses
  // notes small enough to index as a single chunk, which left the chunk-budget
  // setting invisible to this harness: raising maxChars moved nothing here even
  // though it changes what a chunk IS. A longer chunk also carries more
  // unrelated words, diluting BM25 term density, and this is where that shows.
  const longNeedles: Array<[string, string]> = [
    ["sablewing escalation path", "the sablewing escalation path routes through the duty lead"],
    ["hearthstone retention window", "the hearthstone retention window is ninety days"],
    ["padlock rotation interval", "the padlock rotation interval was shortened to seven days"],
    ["quillfeather export limit", "the quillfeather export limit caps at four thousand rows"],
    ["brackenridge failover order", "the brackenridge failover order puts the replica first"],
    ["tidewater approval quorum", "the tidewater approval quorum needs three reviewers"],
  ];
  longNeedles.forEach(([q, fact], i) => {
    const path = `Longform/long-${i}.md`;
    // Windowing applies per SECTION, so the fact's own section has to exceed
    // the budget or the setting never bites: ~6k chars of paragraphs around the
    // fact, split across blank lines so the windower has boundaries to use.
    const para = () => noiseWords(rng, 90);
    const filler = (n: number) => Array.from({ length: n }, para).join("\n\n");
    const section = (n: number) => `## Section ${n}\n\n${para()}\n`;
    seed[path] =
      `# Longform note ${i}\n\n${section(1)}\n` +
      `## Section 2\n\n${filler(5)}\n\n${para()} ${fact} ${para()}\n\n${filler(5)}\n\n` +
      section(3);
    queries.push({ cls: "longnote", query: q, needle: path });
  });

  return { seed, queries };
}

const SCAN: ScanConfig = { includedFolders: [], excludedFolders: [], excludedTags: [], excludedPathPatterns: [] };

/**
 * Session notes as the plugin actually writes them: `startSession` lays down a
 * `## Goals / ## Notes / ## Outcomes` scaffold at creation, so a note only ever
 * gains content — an abandoned session keeps its empty scaffold forever, and a
 * partly-used one keeps whatever sections were never filled.
 *
 * The mix below (2 full, 2 partial, 1 abandoned) models a real project's
 * recent history rather than a worst case; the reported waste is the share of
 * a `get_recent_sessions` page that is headings with nothing under them.
 */
function sessionNotes(): Array<{ path: string; content: string }> {
  const section = (h: string, body: string) => `## ${h}\n\n${body ? `${body}\n\n` : ""}`;
  const note = (stamp: string, goals: string, notes: string, outcomes: string) =>
    `# Session ${stamp} — atlas\n\n${section("Goals", goals)}${section("Notes", notes)}${section("Outcomes", outcomes)}`;
  return [
    {
      path: "Claude Code/Projects/atlas/Sessions/2026-07-30-0915.md",
      content: note(
        "2026-07-30-0915",
        "finish the quota migration and get the rollback path reviewed",
        "migration ran clean on staging; rollback needs a second reviewer before it can ship",
        "migration merged; rollback review carried into the next session",
      ),
    },
    {
      path: "Claude Code/Projects/atlas/Sessions/2026-07-29-1400.md",
      content: note("2026-07-29-1400", "pair on the retry allotment bug", "root cause was an off-by-one in the backoff ceiling", ""),
    },
    {
      path: "Claude Code/Projects/atlas/Sessions/2026-07-28-1100.md",
      content: note(
        "2026-07-28-1100",
        "scope the cache invalidation work",
        "decided nightly invalidation beats per-write; wrote it up in decisions",
        "scoped and estimated at two days",
      ),
    },
    {
      path: "Claude Code/Projects/atlas/Sessions/2026-07-27-0930.md",
      content: note("2026-07-27-0930", "review the vendor contract changes", "", ""),
    },
    { path: "Claude Code/Projects/atlas/Sessions/2026-07-26-1615.md", content: note("2026-07-26-1615", "", "", "") },
  ];
}

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

  it("reports the context cost of an answered query", async () => {
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

    const perClass = new Map<
      string,
      { n: number; results: number; page: number; head: number; answer: number; found: number }
    >();
    for (const q of queries) {
      // Mirror the search_vault_memory path: fetch a deeper pool, drop
      // near-duplicates, re-apply the per-note cap at page size.
      const pool = retriever.retrieve({ query: q.query, limit: RECALL_LIMIT * 2 }, chunks);
      const page = diversifyByNote(dropNearDuplicates(pool), RECALL_LIMIT);

      // Same block shape the MCP tool emits, so the count is what an agent pays.
      const blocks = page.map((r, i) => {
        const start = r.chunk.startLine + 1;
        const end = Math.max(start, r.chunk.endLine + 1);
        const lines = start === end ? `L${start}` : `L${start}–${end}`;
        const modified = new Date(r.chunk.mtime).toISOString().slice(0, 10);
        const head = `${i + 1}. ${r.chunk.notePath} › ${r.chunk.heading || "(note)"} (${lines}, ${modified})`;
        return `${head}\n${r.snippet}`;
      });
      const pageChars = blocks.join("\n\n").length;
      // The locator prefix (path › heading, line range, date) is what the agent
      // pays to be ABLE to fetch more; the rest is retrieved content. Tracking
      // the split shows when the addressing overhead stops earning its keep.
      const headChars = blocks.reduce((n, b) => n + b.slice(0, b.indexOf("\n")).length, 0);
      // Cost to REACH the answer — blocks the agent reads through before (and
      // including) the needle. Rank quality and block size both move this.
      const rank = page.findIndex((r) => r.chunk.notePath === q.needle);
      const answerChars = rank >= 0 ? blocks.slice(0, rank + 1).join("\n\n").length : 0;

      const agg = perClass.get(q.cls) ?? { n: 0, results: 0, page: 0, head: 0, answer: 0, found: 0 };
      agg.n++;
      agg.results += page.length;
      agg.page += pageChars;
      agg.head += headChars;
      if (rank >= 0) {
        agg.found++;
        agg.answer += answerChars;
      }
      perClass.set(q.cls, agg);
    }

    const totals = { n: 0, results: 0, page: 0, head: 0, answer: 0, found: 0 };
    console.log("\n===== context cost per query (chars, lexical) =====");
    console.log("class      queries  hits   page  locator  to-answer");
    const row = (label: string, a: typeof totals) =>
      console.log(
        `${label.padEnd(10)} ${String(a.n).padStart(7)} ${(a.results / a.n).toFixed(1).padStart(5)} ` +
          `${Math.round(a.page / a.n).toString().padStart(6)} ${((a.head / a.page) * 100).toFixed(0).padStart(6)}% ` +
          `${(a.found ? Math.round(a.answer / a.found) : 0).toString().padStart(10)}`,
      );
    for (const [cls, a] of perClass) {
      totals.n += a.n;
      totals.results += a.results;
      totals.page += a.page;
      totals.head += a.head;
      totals.answer += a.answer;
      totals.found += a.found;
      row(cls, a);
    }
    row("ALL", totals);
    console.log("==================================================\n");

    // Budget ceiling, not a savings ratio: a "saved vs whole chunks" number
    // would mostly track how long this corpus's notes are. What the CODE owns
    // is the page's own size — widening the snippet window, dropping dedup, or
    // re-adding per-result score floats all show up here. Loose on purpose.
    const meanPage = totals.page / totals.n;
    expect(meanPage, "mean chars per search result page").toBeLessThan(700);
  }, 120_000);

  it("reports how much of a session-history page is empty scaffold", () => {
    const sessions = sessionNotes();
    // Same block shape get_recent_sessions emits.
    const blocks = sessions.map((s) => `## ${s.path}\n\n${s.content.trim()}`);
    const pageChars = blocks.join("\n\n---\n\n").length;

    // A heading is "empty" when nothing but another heading (or the end of the
    // note) follows it — the scaffold survived but was never filled in.
    let emptyHeadings = 0;
    let emptyChars = 0;
    for (const s of sessions) {
      const lines = s.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith("## ")) continue;
        const next = lines.slice(i + 1).find((l) => l.trim().length > 0);
        if (next === undefined || next.startsWith("## ")) {
          emptyHeadings++;
          emptyChars += lines[i].length + 1;
        }
      }
    }

    console.log("\n===== session-history page cost (chars) =====");
    console.log(`sessions returned    ${sessions.length}`);
    console.log(`page chars           ${pageChars}`);
    console.log(`empty headings       ${emptyHeadings}`);
    console.log(`empty-scaffold chars ${emptyChars} (${((emptyChars / pageChars) * 100).toFixed(1)}% of page)`);
    console.log("=============================================\n");

    // The scaffold share is an observation, not a target — it depends on how
    // many recent sessions were abandoned, and stripping it would be an
    // improvement, so nothing here asserts that waste exists. What IS worth
    // pinning is the budget relationship: a realistic session history must sit
    // well inside the default page budget, so the clip path (which drops whole
    // notes and names them as omitted) stays an edge case rather than the norm.
    expect(pageChars, "realistic session history fits the default budget").toBeLessThan(12_000 / 2);
  });
});
