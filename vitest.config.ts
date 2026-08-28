import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // The real `obsidian` package is types-only, so a source file importing
      // an Obsidian VALUE cannot be resolved under Node at all. The layering
      // test keeps that to a handful of host adapters; this alias exists so
      // ObsidianVaultAdapter's crash-safety paths can be exercised against the
      // real implementation. See tests/stubs/obsidian.ts.
      obsidian: fileURLToPath(new URL("./tests/stubs/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts", "src/ui/**", "src/settings/settings-tab.ts"],
    },
  },
});
