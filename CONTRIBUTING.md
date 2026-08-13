# Contributing to Coder Engram

Thanks for taking an interest. This is a plugin that reads and writes people's
notes and can expose them over a local server, so the bar for changes is
"provably safe", not just "works on my vault". That shapes most of what follows.

Start with [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for setup, the npm
scripts, and how to run the plugin inside a real Obsidian.

## Before you open a pull request

Run the gate. All four must pass:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

If your change touches the Obsidian-facing layer — the vault adapter, the HTTP
client, PDF or OCR extraction, or the UI — also run the end-to-end suite, which
is the only place that code executes at all:

```bash
npm run build && npm run test:e2e
```

It skips cleanly when Obsidian or a display is unavailable, so a "skipped" result
is not a pass. Say which of these you ran in the pull request.

## Two rules that are enforced, not suggested

**The service and core layers must never import `obsidian` or `node:*`.** Only
the UI layer, four named adapters in `src/core/`, and the server layer may.
`tests/architecture.test.ts` fails the build otherwise, and the allowlist lives
in that file — adding to it is a deliberate architectural decision, so it shows
up in review as a code change rather than as drift.

**Every vault path goes through `resolveInVault` / `joinVaultPath` in
`src/utils/paths.ts`.** Never build one by string concatenation; that skips the
normalization and the `..` rejection everything else gets.

## Tests

A bug fix needs a regression test that fails without the fix. More importantly:

**Verify that a new test actually holds something.** A green suite says the
tests pass, not that they would fail if the code broke. Break the line your test
is meant to protect — turning a guard into `if (false)` is usually enough — and
confirm the test goes red. This has repeatedly found tests here that passed for
the wrong reason: an error-class assertion satisfied by a *different* guard
throwing the same class, a write test using a path where append and overwrite
look identical, a size cap whose effect no assertion observed.

Never weaken a test to get a green run. If an existing expectation is wrong, say
in the pull request why the old one was wrong.

## Changes that need extra care

- **Anything touching writes.** Writes default to the append-only review inbox.
  Direct writes are double-gated and off by default, and the server never
  performs one regardless of settings.
- **Anything touching the server.** It binds `127.0.0.1`, authenticates in
  constant time, and applies Host/Origin guards. It exposes a fixed tool list
  with no generic file access.
- **Anything sending data off-machine.** Embeddings are opt-in, and excluded
  notes are never indexed and therefore never sent.

[docs/SECURITY.md](docs/SECURITY.md) states these as invariants. If a change
would weaken one, that is the conversation to have first, in an issue, before
writing code.

## Commits and branches

Work lands on `develop`; `main` is fast-forwarded at release time. Commit
messages follow the existing convention — a `type(scope): summary` subject in
the imperative, and a body that explains *why*, not what the diff already shows.

Do not bump versions or edit `manifest.json` / `versions.json` by hand; releases
run `npm version`, which syncs all three and is gated in CI.

Cutting a release also means updating `CHANGELOG.md`, `README.md`, and
`docs/ROADMAP.md` every time — see "Releasing" in the README for what to check in
each. The README is easy to forget precisely because nothing breaks when it is
wrong, so the suite asserts its stated version against the manifest; that check
fails the release gate, not just the local run.

## Reporting a security issue

Please do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on this repository, or email the address on the author's
GitHub profile, and give it a reasonable window before disclosure.
