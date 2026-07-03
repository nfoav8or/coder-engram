# Architecture

Claude Code Engram is a layered TypeScript Obsidian plugin. The guiding rule is that only the UI layer knows about Obsidian; everything below it talks to the vault through a single `VaultAdapter` interface. That keeps the indexing, retrieval, and memory logic Obsidian-agnostic and unit-testable, and it lets the future local server (M2) reuse the same engine verbatim.

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│ UI layer (imports `obsidian`)                                │
│   main.ts · settings/settings-tab.ts                         │
│   ui/control-panel-view.ts · ui/*-modal.ts                   │
└───────────────┬─────────────────────────────────────────────┘
                │ (only via EngramEngine + plain data)
┌───────────────▼─────────────────────────────────────────────┐
│ Service layer (Obsidian-agnostic)                            │
│   engine.ts (EngramEngine — orchestration facade)            │
│   indexing/IndexManager · retrieval/Retriever                │
│   memory/MemoryStore · memory/MemoryWriter                   │
│   indexing/VaultScanner · memory/ProjectMemory               │
└───────────────┬─────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────┐
│ Core utils (pure, no I/O framework)                          │
│   utils/paths · core/markdown-chunker                        │
│   core/metadata-extractor · retrieval/ranking                │
│   utils/logger · utils/errors · utils/validation             │
└───────────────┬─────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────┐
│ VaultAdapter boundary (core/vault-adapter.ts)                │
│   ObsidianVaultAdapter (prod) · InMemoryVaultAdapter (tests) │
└─────────────────────────────────────────────────────────────┘
```

The **server layer** (`server/`) from the spec is deferred to Milestone 2. When it lands, it sits beside the UI layer and drives the same `EngramEngine`.

## UI layer

- `main.ts` (`EngramPlugin`) — the Obsidian `Plugin` subclass. It loads/migrates settings, constructs an `ObsidianVaultAdapter` and an `EngramEngine`, registers the ten commands, the control-panel view, the ribbon icon, the settings tab, and debounced file-change watchers. It implements the `SettingsHost` and `ControlPanelActions` interfaces so the settings tab and control panel stay decoupled (no import cycles).
- `settings/settings-tab.ts` — renders the settings UI, validates the memory root on entry, and carries the server security warning.
- `ui/control-panel-view.ts` — a right-sidebar `ItemView` showing index stats and quick-action buttons. It talks to `main.ts` only through the `ControlPanelActions` interface.
- `ui/*-modal.ts` — `SearchModal`, `AddMemoryModal`, `PendingMemoryModal`, and the small `PromptModal` / `TextDisplayModal` helpers.

These modules import `obsidian`. Nothing below this layer does.

## Service layer

- `engine.ts` — `EngramEngine` is the orchestration facade shared by UI commands (and, in M2, the server). It owns the scanner, index manager, memory store, memory writer, and retriever, and rebuilds them whenever settings change. It depends only on a `VaultAdapter`, a settings object, and a `Logger`.
- `indexing/vault-scanner.ts` — `VaultScanner` enumerates eligible Markdown notes and applies folder/tag/pattern filters.
- `indexing/index-manager.ts` — `IndexManager` builds, incrementally refreshes, persists, and loads the JSON index.
- `retrieval/retriever.ts` + `retrieval/lexical-retriever.ts` — the `Retriever` interface and the M1 BM25 `LexicalRetriever`.
- `memory/memory-store.ts` — `MemoryStore` handles read-side context (global/project/sessions) and non-destructive scaffold creation.
- `memory/memory-writer.ts` — `MemoryWriter` is the only component that writes memory: inbox proposals and double-gated direct writes.
- `memory/project-memory.ts` — `ProjectMemory` scaffolds and enumerates per-project folders and session notes.

## Core utils

Pure, dependency-light modules with no Obsidian imports:

- `utils/paths.ts` — path normalization and the `resolveInVault` / `isInsideRoot` safety functions.
- `core/markdown-chunker.ts` — heading- and fence-aware chunking.
- `core/metadata-extractor.ts` — frontmatter/tag/link extraction with no YAML dependency.
- `retrieval/ranking.ts` — tokenization, structural filtering, and snippet building shared by retrievers.
- `utils/logger.ts` — debug-gated logger with secret redaction.
- `utils/errors.ts` — typed errors (`PathSecurityError`, `ConfigError`, …).
- `utils/validation.ts`, `utils/debounce.ts` — small helpers.

## VaultAdapter boundary

`core/vault-adapter.ts` defines the `VaultAdapter` interface — the single boundary between the plugin and Obsidian's file system. It exposes `read`, `write`, `append`, `exists`, `ensureFolder`, `listMarkdownFiles`, and `getMtime`, all operating on validated vault-relative paths. As defense-in-depth, every adapter method calls `assertRelative` and refuses absolute paths.

Two implementations:

- `ObsidianVaultAdapter` (`core/obsidian-vault-adapter.ts`) — the production adapter backed by Obsidian's `Vault` API.
- `InMemoryVaultAdapter` (in `vault-adapter.ts`) — a flat path→content map used throughout the test suite.

Because the whole service layer depends on this interface rather than on `obsidian`, the tests exercise real indexing/retrieval/memory logic without a running Obsidian.

## Dependency direction

Dependencies point **downward only**: UI → service → core utils → `VaultAdapter`. The service and core layers never import `obsidian`, and lower layers never import upward. The embedding provider (`embeddings/`) is an interface plus a mock, injected where needed; it is off the critical path since retrieval works with no provider.

## Embeddings (M3-facing)

`embeddings/embedding-provider.ts` defines the `EmbeddingProvider` interface and a `cosineSimilarity` helper; `embeddings/mock-embedding-provider.ts` is a deterministic hash-based mock for tests. Real providers (Ollama, OpenAI-compatible) and a vector retriever slot in at M3 behind the existing `Retriever` interface without changing callers.
