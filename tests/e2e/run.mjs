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
import { spawn, execSync } from "node:child_process";
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
const pluginDir = path.join(vault, ".obsidian", "plugins", "claude-code-engram");
fs.mkdirSync(pluginDir, { recursive: true });
fs.mkdirSync(path.join(vault, "Notes"), { recursive: true });
fs.mkdirSync(udd, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  fs.copyFileSync(path.join(REPO, f), path.join(pluginDir, f));
}
fs.writeFileSync(path.join(vault, ".obsidian", "community-plugins.json"), '["claude-code-engram"]');
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
  await page.evaluate(() => window.app.commands.executeCommandById("claude-code-engram:search-memory"));
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
    if (pm.setEnable) pm.setEnable(true);
    if (!pm.plugins["claude-code-engram"]) {
      await (pm.enablePluginAndSave?.("claude-code-engram") ?? pm.enablePlugin?.("claude-code-engram"));
    }
  });
  await page.waitForFunction(() => !!window.app.plugins.plugins["claude-code-engram"], null, { timeout: 15000 });
  check("plugin loaded in Obsidian", await page.evaluate(() => !!window.app.plugins.plugins["claude-code-engram"]));

  // Poll the real search UI until the reindex has produced results (gates on the
  // actual rendered path rather than engine internals).
  let ollama = [];
  for (let i = 0; i < 25 && ollama.length === 0; i++) {
    if (i % 8 === 0) {
      await page.evaluate(() => window.app.commands.executeCommandById("claude-code-engram:reindex-vault"));
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

  await page.screenshot({ path: path.join(tmp, "search.png") });
} catch (e) {
  check("harness ran without throwing", false, e.message);
} finally {
  if (browser) await browser.close();
  try { proc.kill("SIGTERM"); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} e2e checks passed`);
process.exit(failed ? 1 : 0);
