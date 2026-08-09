import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The layering rule this project is built on — "the service/core layers must
 * never import `obsidian` or `node:*`" — was documented in CLAUDE.md and
 * enforced by nothing. It is exactly the kind of rule a refactor breaks
 * silently: an `import { Notice } from "obsidian"` added to a service file
 * still compiles, still passes every other test, and only fails later as an
 * untestable module or a broken headless build.
 *
 * The allowlists below are the same ones CLAUDE.md and docs/ARCHITECTURE.md
 * state in prose. Adding a file here is a deliberate architectural decision, so
 * making it a code change is the point.
 */

/** Files permitted to import `obsidian`: the UI layer plus four thin adapters. */
const OBSIDIAN_ALLOWED = [
  "src/main.ts",
  "src/settings/settings-tab.ts",
  "src/core/obsidian-vault-adapter.ts",
  "src/core/obsidian-http-client.ts",
  "src/core/obsidian-pdf-extractor.ts",
  "src/core/obsidian-ocr-extractor.ts",
];

/**
 * Files permitted to import `node:*`. The server layer only ever runs under
 * Node (Electron's main process, and vitest's node environment), so it may;
 * the pure core may not, because that is what keeps it runnable anywhere.
 */
const NODE_ALLOWED = ["src/server/local-server.ts", "src/server/auth.ts"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = sourceFiles("src").map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("layering", () => {
  it("finds the sources at all", () => {
    // Guards the guard: a path change that silently emptied this list would
    // make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(30);
  });

  it("keeps `obsidian` out of everything but the UI layer and its four adapters", () => {
    // Type-only imports do not count, and the distinction is the whole point
    // of the rule rather than a hole in it: `import type` is erased, so it
    // creates no runtime dependency on the host and the file still loads in
    // the Node test environment. `setting-definitions.ts` relies on exactly
    // that — it names Obsidian's declarative-settings types while remaining a
    // plain value this suite can build and assert over. A value import is what
    // couples a module to the host, and that is still refused everywhere below.
    const importers = files
      .filter((f) => {
        const withoutTypeImports = f.text.replace(/import\s+type\s+[^;]*?from\s+"obsidian";/g, "");
        return (
          /from "obsidian"/.test(withoutTypeImports) || /require\("obsidian"\)/.test(withoutTypeImports)
        );
      })
      .map((f) => f.path.replace(/\\/g, "/"));
    const uiLayer = (p: string) => p.startsWith("src/ui/");
    const offenders = importers.filter((p) => !uiLayer(p) && !OBSIDIAN_ALLOWED.includes(p));
    expect(offenders).toEqual([]);
  });

  it("keeps `node:*` out of everything but the server layer", () => {
    const importers = files
      .filter((f) => /from "node:/.test(f.text))
      .map((f) => f.path.replace(/\\/g, "/"));
    expect(importers.filter((p) => !NODE_ALLOWED.includes(p))).toEqual([]);
  });

  it("routes every vault path through the resolveInVault choke-point", () => {
    // A path built by concatenation skips normalization and the `..` rejection
    // that every other path gets. `paths.ts` is where that logic lives, so it
    // is the one file allowed to assemble a path from raw pieces.
    const offenders = files
      .filter((f) => !f.path.replace(/\\/g, "/").endsWith("src/utils/paths.ts"))
      .filter((f) => /`\$\{[a-zA-Z.]*(root|folder|dir)[a-zA-Z.]*\}\//i.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
