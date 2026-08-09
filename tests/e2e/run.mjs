/**
 * End-to-end UI smoke test — drives the REAL plugin inside a real Obsidian.
 *
 * Unlike the Vitest suite (pure core, node env), this launches the packaged
 * Obsidian app, loads the built plugin into a throwaway vault, and asserts on
 * the rendered DOM. It is LOCAL-ONLY: it needs Obsidian installed and a display,
 * so it is intentionally NOT part of `npm test` or CI. Run it with:
 *
 *     npm run build && npm run test:e2e
 *
 * Obsidian is found via $OBSIDIAN_BIN, then a few common locations, then $PATH.
 * If Obsidian or a display is missing, the script SKIPS (exit 0) rather than
 * failing, so it is safe to invoke anywhere.
 *
 * Mechanism: Obsidian is a packaged Electron app that ignores Playwright's
 * auto-launch attach, so we launch it ourselves with --remote-debugging-port
 * and connect with chromium.connectOverCDP.
 */
import playwright from "playwright-core";
import http from "node:http";
import { spawn, execSync, spawnSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = playwright;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 9200 + Math.floor(Math.random() * 400);

function skip(reason) {
  console.log(`SKIP e2e: ${reason}`);
  process.exit(0);
}

function findObsidian() {
  const env = process.env.OBSIDIAN_BIN;
  if (env) return fs.existsSync(env) ? env : null;
  for (const c of ["/opt/Obsidian/obsidian", "/usr/bin/obsidian", "/usr/local/bin/obsidian"]) {
    if (fs.existsSync(c)) return c;
  }
  try {
    return execSync("command -v obsidian", { shell: "/bin/bash" }).toString().trim() || null;
  } catch {
    return null;
  }
}

if (!process.env.DISPLAY && process.platform === "linux") skip("no DISPLAY (headless)");
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  if (!fs.existsSync(path.join(REPO, f))) skip(`missing ${f} — run \`npm run build\` first`);
}
const obsidian = findObsidian();
if (!obsidian) skip("Obsidian binary not found (set $OBSIDIAN_BIN)");

// --- Build an isolated throwaway vault + Obsidian config -------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-e2e-"));
const vault = path.join(tmp, "vault");
const udd = path.join(tmp, "udd");
const pluginDir = path.join(vault, ".obsidian", "plugins", "coder-engram");
fs.mkdirSync(pluginDir, { recursive: true });
fs.mkdirSync(path.join(vault, "Notes"), { recursive: true });
fs.mkdirSync(udd, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  fs.copyFileSync(path.join(REPO, f), path.join(pluginDir, f));
}
fs.writeFileSync(path.join(vault, ".obsidian", "community-plugins.json"), '["coder-engram"]');
// The "restart"/"art" sentence is the discriminating case: substring highlighting
// would wrongly split "restart" into rest<mark>art</mark>.
fs.writeFileSync(
  path.join(vault, "Notes", "ollama.md"),
  "# Ollama notes\n\nThe ollama server runs embeddings locally. To restart indexing, study the art of ranking with ollama.\n",
);
fs.writeFileSync(
  path.join(vault, "Notes", "embeddings.md"),
  "# Embeddings\n\nHybrid retrieval fuses lexical and vector scores. Ollama provides embeddings.\n",
);
// The "Bravo" section's heading is line 4 (0-based), so open-at-line must land
// the cursor at 4 — proving it uses the chunk's line span, not the file top.
fs.writeFileSync(
  path.join(vault, "Notes", "lines.md"),
  "# Alpha\n\nalpha section body about ranking.\n\n## Bravo\n\nuniqueword marker lives in the bravo section only.\n",
);
// A minimal but structurally valid single-page PDF (correct xref offsets) so
// the real Obsidian's loadPdfJs() extraction path can be exercised end-to-end.
function minimalPdf(text) {
  const esc = text.replace(/([()\\])/g, "\\$1");
  const objects = [];
  objects[1] = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  objects[2] = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  objects[3] =
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
    "/Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n";
  const stream = `BT /F1 12 Tf 72 720 Td (${esc}) Tj ET`;
  objects[4] = `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
  objects[5] = "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = pdf.length;
    pdf += objects[i];
  }
  const xrefPos = pdf.length;
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
fs.mkdirSync(path.join(vault, "Papers"), { recursive: true });
fs.writeFileSync(path.join(vault, "Papers", "telemetry.pdf"), minimalPdf("Peregrine falcon telemetry protocols"));

// A minimal but valid docx (ZIP of one word/document.xml) so the dependency-
// free office extraction path (DecompressionStream) runs in real Obsidian.
function minimalZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(text);
    const data = new Uint8Array(deflateRawSync(raw));
    const lfh = new Uint8Array(30);
    const v = new DataView(lfh.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(8, 8, true);
    v.setUint32(18, data.length, true);
    v.setUint32(22, raw.length, true);
    v.setUint16(26, nameBytes.length, true);
    const lfhOffset = offset;
    chunks.push(lfh, nameBytes, data);
    offset += lfh.length + nameBytes.length + data.length;
    const cd = new Uint8Array(46);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
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
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, Object.keys(entries).length, true);
  ev.setUint16(10, Object.keys(entries).length, true);
  ev.setUint32(12, offset - cdStart, true);
  ev.setUint32(16, cdStart, true);
  chunks.push(eocd);
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
fs.writeFileSync(
  path.join(vault, "Papers", "charter.docx"),
  minimalZip({
    "word/document.xml":
      "<w:document><w:body><w:p><w:r><w:t>Wandering albatross charter obligations</w:t></w:r></w:p></w:body></w:document>",
  }),
);

const vaultId = Math.random().toString(16).slice(2) + Date.now().toString(16);
fs.writeFileSync(
  path.join(udd, "obsidian.json"),
  JSON.stringify({ vaults: { [vaultId]: { path: vault, ts: Date.now(), open: true } } }),
);

// --- Test runner -----------------------------------------------------------
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const proc = spawn(obsidian, ["--no-sandbox", `--user-data-dir=${udd}`, `--remote-debugging-port=${PORT}`], {
  stdio: "ignore",
});

async function waitEndpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("CDP endpoint never came up");
}

async function runSearch(page, query) {
  await page.evaluate(() => window.app.commands.executeCommandById("coder-engram:search-memory"));
  const input = page.locator(".modal input[type=text]").first();
  await input.waitFor({ timeout: 10000 });
  await input.fill(query);
  await input.press("Enter");
  await page.waitForFunction(
    () => {
      const box = document.querySelector(".engram-search-results");
      return box && (box.querySelector(".engram-search-result") || box.querySelector("p"));
    },
    null,
    { timeout: 10000 },
  );
  const snippets = await page.$$eval(".engram-result-snippet", (els) => els.map((e) => e.innerHTML));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  return snippets;
}

let browser;
try {
  await waitEndpoint();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("index.html")) || ctx.pages()[0];
  await page.waitForFunction(() => !!window.app?.workspace?.layoutReady, null, { timeout: 30000 });

  // A brand-new vault boots in Restricted Mode, so listing the plugin in
  // community-plugins.json is not enough — turn off restricted mode and enable
  // the plugin through the API, which is robust to first-run state.
  await page.evaluate(async () => {
    const pm = window.app.plugins;
    // setEnable(true) (leaving Restricted Mode) loads community plugins
    // ASYNCHRONOUSLY — checking pm.plugins immediately races it, and a second
    // enablePluginAndSave then creates a SECOND plugin instance: commands stay
    // registered to one instance while pm.plugins holds the other, each with
    // its own engine. Poll first; force-enable only if genuinely absent.
    if (pm.setEnable) pm.setEnable(true);
    for (let i = 0; i < 50 && !pm.plugins["coder-engram"]; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!pm.plugins["coder-engram"]) {
      await (pm.enablePluginAndSave?.("coder-engram") ?? pm.enablePlugin?.("coder-engram"));
    }
  });
  await page.waitForFunction(() => !!window.app.plugins.plugins["coder-engram"], null, { timeout: 15000 });
  check("plugin loaded in Obsidian", await page.evaluate(() => !!window.app.plugins.plugins["coder-engram"]));

  // Poll the real search UI until the reindex has produced results (gates on the
  // actual rendered path rather than engine internals).
  let ollama = [];
  for (let i = 0; i < 25 && ollama.length === 0; i++) {
    if (i % 8 === 0) {
      await page.evaluate(() => window.app.commands.executeCommandById("coder-engram:reindex-vault"));
    }
    await page.waitForTimeout(1000);
    ollama = await runSearch(page, "ollama");
  }
  check("search 'ollama' returns results after reindex", ollama.length > 0, `${ollama.length} snippet(s)`);
  check("matched term wrapped in <mark>", /<mark>ollama<\/mark>/i.test(ollama.join("\n")));

  const art = (await runSearch(page, "art")).join("\n");
  check("standalone 'art' is highlighted", /<mark>art<\/mark>/i.test(art));
  check(
    "word-boundary: 'restart' is not split by a mark",
    /restart/i.test(art) && !/rest<mark>/i.test(art),
  );

  // Line-span surfacing + open-at-line.
  await page.evaluate(() => window.app.commands.executeCommandById("coder-engram:search-memory"));
  const uInput = page.locator(".modal input[type=text]").first();
  await uInput.waitFor({ timeout: 10000 });
  await uInput.fill("uniqueword");
  await uInput.press("Enter");
  await page.waitForSelector(".engram-search-result", { timeout: 10000 });
  const lineLabel = await page.locator(".engram-result-lines").first().innerText();
  check("result shows a line range", /Lines?\s*\d+/.test(lineLabel), lineLabel);

  await page.locator(".engram-search-result").first().click();
  await page.waitForTimeout(800);
  const opened = await page.evaluate(() => {
    const f = window.app.workspace.getActiveFile();
    const ed = window.app.workspace.activeEditor?.editor;
    return { path: f?.path ?? null, line: ed ? ed.getCursor().line : null };
  });
  check("clicking opens the matched note", !!opened.path && opened.path.endsWith("lines.md"), opened.path);
  check("cursor lands at the chunk's start line (not the file top)", opened.line === 4, `cursor line ${opened.line}`);

  // --- MCP server end-to-end: the exact wire path Claude Code uses ----------
  // Enable the real localhost server (port 0 = OS-assigned, no collisions) and
  // drive it with JSON-RPC from this process.
  const TOKEN = "e2e-token-0123456789abcdef0123456789abcdef";
  const addr = await page.evaluate(async (token) => {
    const plugin = window.app.plugins.plugins["coder-engram"];
    plugin.settings.server = { ...plugin.settings.server, enabled: true, port: 0, token };
    return await plugin.server.start(plugin.settings);
  }, TOKEN);
  check(
    "MCP server starts on localhost",
    addr && addr.host === "127.0.0.1" && addr.port > 0,
    `${addr.host}:${addr.port}`,
  );

  const rpc = async (method, params) => {
    const res = await fetch(`http://127.0.0.1:${addr.port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method, params }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const toolText = (r) => r.body?.result?.content?.[0]?.text ?? "";

  // Auth is enforced before any dispatch.
  const noAuth = await fetch(`http://127.0.0.1:${addr.port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("MCP rejects a missing bearer token", noAuth.status === 401, `status ${noAuth.status}`);

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  check("MCP initialize succeeds", init.status === 200 && !!init.body?.result);
  // Negotiation over the wire, not just in the unit tests: an older revision we
  // do implement is agreed to verbatim...
  check(
    "MCP agrees to an older protocol revision it implements",
    init.body?.result?.protocolVersion === "2024-11-05",
    init.body?.result?.protocolVersion ?? "(none)",
  );
  // ...and one we do not is answered with ours, so the client can decide to
  // disconnect rather than proceed on a promise we cannot keep.
  const future = await rpc("initialize", {
    protocolVersion: "2026-07-28",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  check(
    "MCP answers an unimplemented revision with its own",
    future.body?.result?.protocolVersion === "2025-06-18",
    future.body?.result?.protocolVersion ?? "(none)",
  );

  const search = await rpc("tools/call", {
    name: "search_vault_memory",
    arguments: { query: "ollama" },
  });
  const searchText = toolText(search);
  check(
    "MCP search returns line-ranged, dated results",
    /Notes\/ollama\.md/.test(searchText) && /\(L\d+[^)]*, \d{4}-\d{2}-\d{2}\)/.test(searchText),
    searchText.split("\n")[2] ?? "",
  );

  // The safety loop over the wire: a proposal lands inbox-first, and after a
  // reindex it surfaces in search labelled pending — never as accepted memory.
  const proposal = "Proposed decision: adopt engram zebra-cadence for session memory.";
  const add = await rpc("tools/call", { name: "add_memory", arguments: { content: proposal, type: "decision" } });
  check("MCP add_memory lands in the review inbox", /pending-memory\.md/.test(toolText(add)), toolText(add));

  // A second proposal must not replace the first. The inbox is append-only,
  // and `ObsidianVaultAdapter.append` is the production path that makes it so —
  // the in-memory adapter the unit suite uses has its own implementation, so
  // this is the only run where the real one is exercised at all.
  const second = "Proposed decision: keep engram quokka-interval for attachment scans.";
  await rpc("tools/call", { name: "add_memory", arguments: { content: second, type: "decision" } });
  const inboxFile = path.join(vault, "Claude Code", "Memory", "Inbox", "pending-memory.md");
  const inboxText = fs.existsSync(inboxFile) ? fs.readFileSync(inboxFile, "utf8") : "";
  check(
    "a second proposal appends rather than replacing the first",
    /zebra-cadence/.test(inboxText) && /quokka-interval/.test(inboxText),
    `${inboxText.length} chars, entries: ${(inboxText.match(/## Pending Memory:/g) ?? []).length}`,
  );

  // Enable attachment indexing BEFORE the single server-side reindex (the
  // reindex tool has a 15s cooldown), so one reindex covers the inbox
  // proposal AND the PDF fixture.
  await page.evaluate(async () => {
    const plugin = window.app.plugins.plugins["coder-engram"];
    plugin.settings.indexAttachments = true;
    await plugin.onSettingsChanged();
  });
  await rpc("tools/call", { name: "reindex_vault", arguments: {} });
  const echo = await rpc("tools/call", {
    name: "search_vault_memory",
    arguments: { query: "zebra-cadence session memory" },
  });
  const echoText = toolText(echo);
  check(
    "unreviewed proposal comes back labelled PENDING REVIEW",
    /zebra-cadence/.test(echoText) && /\[PENDING REVIEW/.test(echoText),
    echoText.split("\n")[1] ?? "",
  );

  // PDF attachment: extracted via the real Obsidian's loadPdfJs() and indexed
  // like a note (searchable with a Page breadcrumb, readable by path).
  const pdfSearch = await rpc("tools/call", {
    name: "search_vault_memory",
    arguments: { query: "peregrine falcon telemetry" },
  });
  const pdfText = toolText(pdfSearch);
  check(
    "PDF attachment text is indexed and searchable (loadPdfJs)",
    /Papers\/telemetry\.pdf/.test(pdfText) && /Page 1/.test(pdfText),
    pdfText.split("\n")[2] ?? "",
  );
  const pdfRead = await rpc("tools/call", {
    name: "get_note_context",
    arguments: { path: "Papers/telemetry.pdf" },
  });
  check(
    "PDF attachment is readable via get_note_context",
    /Peregrine falcon telemetry protocols/.test(toolText(pdfRead)),
    toolText(pdfRead).split("\n")[0] ?? "",
  );

  const docxSearch = await rpc("tools/call", {
    name: "search_vault_memory",
    arguments: { query: "wandering albatross charter" },
  });
  check(
    "docx attachment text is indexed (DecompressionStream ZIP path)",
    /Papers\/charter\.docx/.test(toolText(docxSearch)),
    toolText(docxSearch).split("\n")[2] ?? "",
  );

  // An edit to an already-indexed note must reach search. An incremental
  // refresh re-reads only files whose mtime moved, so this is what proves the
  // adapter reports real mtimes: with a constant one, every note looks
  // unchanged forever and edits are silently never indexed.
  await page.evaluate(async () => {
    const app = window.app;
    const engine = app.plugins.plugins["coder-engram"].engine;
    // Refresh once first so the scan config matches the one the known mtimes
    // were taken under — that is the condition for the INCREMENTAL path, and a
    // full rescan would re-read the edit no matter what mtimes the adapter
    // reported, making this check pass for the wrong reason.
    await engine.refresh();
    const file = app.vault.getAbstractFileByPath("Notes/ollama.md");
    const before = file.stat.mtime;
    await app.vault.modify(file, "# Ollama notes\n\nlocal embeddings via a wombat-relay endpoint\n");
    // Obsidian's cached stat is what the adapter reports, and it does not
    // update synchronously with modify(). Refreshing before it settles reads
    // the note as unchanged — a real flake, not a stale index.
    for (let i = 0; i < 40 && file.stat.mtime === before; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await engine.refresh();
  });
  const edited = await rpc("tools/call", {
    name: "search_vault_memory",
    arguments: { query: "wombat-relay endpoint" },
  });
  // NOT just /wombat-relay/: the no-results reply echoes the query back, so
  // that alone passes while the edit never reached the index at all.
  check(
    "an edited note is re-indexed on refresh",
    /Notes\/ollama\.md/.test(toolText(edited)) && !/No results/.test(toolText(edited)),
    toolText(edited).split("\n")[0] ?? "",
  );

  // ObsidianHttpClient is the plugin's ONLY outbound network path and, like the
  // vault adapter, has no unit test — the suite drives embedding providers
  // through FakeHttpClient, so `requestUrl` itself never runs there. A stub
  // endpoint on loopback exercises the real one, and lets the API key's
  // handling be checked where it actually travels: in the header, and nowhere
  // else. The key is fake and the server is local, so nothing leaves the box.
  const seen = [];
  const stub = http.createServer((sreq, sres) => {
    let body = "";
    sreq.on("data", (c) => (body += c));
    sreq.on("end", () => {
      seen.push({ url: sreq.url, auth: sreq.headers.authorization ?? "", body });
      if (sreq.url?.endsWith("/models")) {
        sres.writeHead(200, { "Content-Type": "application/json" });
        sres.end(JSON.stringify({ data: [{ id: "stub-embed" }] }));
        return;
      }
      const count = (JSON.parse(body || "{}").input ?? []).length;
      sres.writeHead(200, { "Content-Type": "application/json" });
      sres.end(
        JSON.stringify({
          data: Array.from({ length: count }, (_, i) => ({ index: i, embedding: [0.1, 0.2, 0.3, 0.4] })),
        }),
      );
    });
  });
  await new Promise((res) => stub.listen(0, "127.0.0.1", res));
  const stubPort = stub.address().port;
  const FAKE_KEY = "e2e-not-a-real-key";
  await page.evaluate(
    async ([port, key]) => {
      const plugin = window.app.plugins.plugins["coder-engram"];
      Object.assign(plugin.settings, {
        embeddingProvider: "openai-compatible",
        embeddingModel: "stub-embed",
        embeddingEndpoint: `http://127.0.0.1:${port}`,
        embeddingApiKey: key,
        retrievalMode: "hybrid",
      });
      await plugin.onSettingsChanged();
      await plugin.engine.syncEmbeddings();
    },
    [stubPort, FAKE_KEY],
  );
  const embedCalls = seen.filter((r) => (r.url ?? "").endsWith("/embeddings"));
  check(
    "embedding request reaches a real endpoint through requestUrl",
    embedCalls.length > 0,
    `${seen.length} request(s): ${seen.map((r) => r.url).join(", ")}`,
  );
  check(
    "the API key travels in the Authorization header and nowhere else",
    embedCalls.length > 0 &&
      embedCalls.every((r) => r.auth === `Bearer ${FAKE_KEY}` && !r.body.includes(FAKE_KEY)),
    embedCalls[0] ? `auth ${embedCalls[0].auth.slice(0, 12)}…, body ${embedCalls[0].body.length}b` : "",
  );
  const mode = await page.evaluate(() =>
    window.app.plugins.plugins["coder-engram"].engine.getRetrievalMode(),
  );
  check("retrieval switches to hybrid once vectors exist", mode === "hybrid", mode);
  await new Promise((res) => stub.close(res));

  // --- declarative settings tab (Obsidian 1.13+) ---------------------------
  // The settings UI is the one part of this plugin no unit test can reach:
  // `setting-definitions.ts` is asserted as data, but whether Obsidian renders
  // it — and whether it renders the DECLARATIVE path rather than the legacy
  // `display()` — can only be seen in the real app.
  const settings = await page.evaluate(async () => {
    const app = window.app;
    const plugin = app.plugins.plugins["coder-engram"];
    app.setting.open();
    app.setting.openTabById("coder-engram");
    await new Promise((r) => setTimeout(r, 800));
    const tab = app.setting.activeTab;
    const el = () => app.setting.activeTab.containerEl;
    const rowFor = (label) =>
      Array.from(el().querySelectorAll(".setting-item")).find(
        (row) => row.querySelector(".setting-item-name")?.textContent.trim() === label,
      );
    const shown = (label) => {
      const row = rowFor(label);
      return !!row && row.offsetParent !== null && getComputedStyle(row).display !== "none";
    };
    // Earlier checks left the provider on openai-compatible, so each assertion
    // sets the state it is about rather than inheriting it.
    // Re-render the way Obsidian does. NOT `tab.display()`: that is the
    // pre-1.13 imperative path, still shipped for older apps, and calling it
    // here would paint the legacy UI over the declarative one — which is
    // exactly how an earlier version of this check passed while testing
    // nothing.
    const render = async (provider) => {
      plugin.settings.embeddingProvider = provider;
      tab.update?.();
      app.setting.openTabById("coder-engram");
      await new Promise((r) => setTimeout(r, 400));
    };

    await render("none");
    const keyHiddenForNone = !shown("API key");
    await render("ollama");
    const keyHiddenForOllama = !shown("API key");
    const endpointShownForOllama = shown("Endpoint");
    await render("openai-compatible");
    const keyShownForOpenAi = shown("API key");
    const masked = el().querySelectorAll('input[type="password"]').length;
    await render("none");

    // Drive a real control the way a user would, to prove the value plumbing
    // (getControlValue / setControlValue) is wired both ways.
    const before = plugin.settings.indexingEnabled;
    const toggle = rowFor("Enable indexing")?.querySelector(".checkbox-container");
    toggle?.click();
    await new Promise((r) => setTimeout(r, 200));
    const afterClick = plugin.settings.indexingEnabled;
    toggle?.click();
    await new Promise((r) => setTimeout(r, 200));

    const headings = Array.from(el().querySelectorAll(".setting-item-heading"))
      .map((n) => n.textContent.trim())
      .filter(Boolean);
    return {
      declarativeGroups: Array.isArray(tab?.settingItems) ? tab.settingItems.length : -1,
      rows: el().querySelectorAll(".setting-item").length,
      headings,
      masked,
      keyHiddenForNone,
      keyHiddenForOllama,
      endpointShownForOllama,
      keyShownForOpenAi,
      toggleFlipped: toggle ? afterClick !== before : "no toggle found",
      restored: plugin.settings.indexingEnabled === before,
    };
  });

  check(
    "settings render from the declarative definitions, not the legacy display()",
    settings.declarativeGroups > 0,
    `${settings.declarativeGroups} groups, ${settings.rows} rows`,
  );
  check(
    "every settings group renders",
    ["Indexing", "Retrieval & embeddings", "Memory write safety", "Advanced"].every((h) =>
      settings.headings.some((x) => x.startsWith(h)),
    ),
    settings.headings.join(" · "),
  );
  check(
    "the API key field appears only for the provider that sends one",
    settings.keyHiddenForNone && settings.keyHiddenForOllama && settings.keyShownForOpenAi,
    `none=${!settings.keyHiddenForNone} ollama=${!settings.keyHiddenForOllama} openai=${settings.keyShownForOpenAi}`,
  );
  check(
    "the endpoint field appears for a local provider",
    settings.endpointShownForOllama,
  );
  check(
    "the token and API key render masked",
    settings.masked === 2,
    `${settings.masked} password input(s)`,
  );
  check(
    "clicking a rendered control writes through to settings",
    settings.toggleFlipped === true && settings.restored,
    `flipped=${settings.toggleFlipped} restored=${settings.restored}`,
  );

  // Every durable write goes temp-sibling → move the old copy aside → rename
  // into place → delete the backup. That last step only runs on the success
  // path, and nothing else can check it: the InMemoryVaultAdapter does not
  // implement the dance, and `obsidian` ships types with no runtime, so
  // ObsidianVaultAdapter cannot be unit-tested at all. By now the run has
  // written the index, the extraction cache and the inbox several times over,
  // so leftovers would be sitting in the vault the user has to look at.
  const debris = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.engram-(tmp|bak)-/.test(e.name)) debris.push(path.relative(vault, full));
    }
  };
  walk(vault);
  check("writes leave no temp or backup files behind", debris.length === 0, debris.join(", "));

  await page.screenshot({ path: path.join(tmp, "search.png") });
} catch (e) {
  check("harness ran without throwing", false, e.message);
} finally {
  if (browser) await browser.close();
  // Obsidian spawns a helper process tree; killing only the main process leaves
  // children writing into the vault dir, racing removal. Kill every process for
  // this unique --user-data-dir, then remove (retry for lingering handles).
  try { proc.kill("SIGKILL"); } catch { /* ignore */ }
  try { spawnSync("pkill", ["-9", "-f", udd]); } catch { /* pkill may be absent */ }
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch { /* keep retrying */ }
    if (!fs.existsSync(tmp)) break;
  }
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} e2e checks passed`);
process.exit(failed ? 1 : 0);
