module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    sourceType: "module",
    ecmaVersion: 2020,
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
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
    "no-console": "off",
  },
};
