import { defineConfig } from "vitest/config";

// On-demand scale benchmark (`npm run bench`). Kept separate from the default
// suite (vitest.config.ts) so `npm test`/CI stay fast; the *.bench.ts files are
// heavy and machine-dependent, like the local-only e2e harness.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.bench.ts"],
    globals: false,
    testTimeout: 120_000,
  },
});
