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
import { spawn, execSync, spawnSync } from "node:child_process";
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
