import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";

const banner = `/*
 * Coder Engram — bundled plugin artifact.
 * This file is generated from src/. Do not edit directly.
 */`;

const production = process.argv[2] === "production";

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian, Electron, CodeMirror and Node builtins are provided by the host.
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    // Node builtins are provided by the Electron host. `builtin-modules` lists
    // bare names ("http"); we also externalize the "node:"-prefixed forms the
    // server layer imports (e.g. "node:http", "node:crypto").
    ...builtins,
    ...builtins.map((m) => `node:${m}`),
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log("[esbuild] watching for changes…");
}
