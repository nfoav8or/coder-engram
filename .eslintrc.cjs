module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    sourceType: "module",
    ecmaVersion: 2020,
    // Type information, so the rules below can see where `any` actually flows.
    project: ["./tsconfig.eslint.json"],
    tsconfigRootDir: __dirname,
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    // The type-aware set. The Obsidian review scan flags unchecked `any` and
    // floating promises; without this, our own lint could not see either, so
    // those findings only ever surfaced after a release.
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
  ],
  env: {
    node: true,
    browser: true,
    es2020: true,
  },
  ignorePatterns: ["main.js", "node_modules/", "coverage/", "esbuild.config.mjs"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/explicit-module-boundary-types": "off",
    // Implementing an async interface method (TextExtractor.extract,
    // EmbeddingProvider.embed) sometimes needs no await — test fakes and
    // passthrough adapters return a value directly. The signature is the
    // contract, so requiring an await inside would mean adding a pointless one.
    "@typescript-eslint/require-await": "off",
    "no-console": "off",
  },
};
