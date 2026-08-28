/**
 * Test stub for the `obsidian` module.
 *
 * The real package ships TYPES ONLY (`"main": ""`, just `.d.ts` files), so any
 * source file that imports an Obsidian *value* cannot be loaded by the Node
 * test suite at all — module resolution fails before `vi.mock` gets a chance to
 * intervene. Nearly every file avoids that by design (the layering rule in
 * `tests/architecture.test.ts` enforces it), and the few host adapters that do
 * import values are covered by the Playwright e2e harness.
 *
 * `ObsidianVaultAdapter` is the one exception worth bridging: its `write()`
 * performs a temp-file → backup → rename dance whose entire purpose is to make
 * a crash or a failed rename non-destructive to the user's memory files, and
 * that logic depends on nothing but the injected `app.vault.adapter` object.
 * Aliasing this stub in `vitest.config.ts` lets those failure paths be tested
 * against the REAL adapter rather than a parallel re-implementation of it.
 *
 * Deliberately minimal: add to it only when a test needs a specific value, and
 * never treat it as a model of Obsidian's behavior. `normalizePath` here
 * approximates the real one (separator and slash cleanup, NFC) closely enough
 * for path plumbing; tests that depend on exact host normalization belong in
 * the e2e harness.
 */

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .normalize("NFC");
}
