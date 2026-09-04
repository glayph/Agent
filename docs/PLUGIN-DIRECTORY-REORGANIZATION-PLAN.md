# Plugin Directory Reorganization Plan

## Ownership decision

The canonical Plugin implementation root is `packages/core/src/plugins/`. Provider implementations currently under `packages/core/src/llm/provider/Plug-in/` will move to `packages/core/src/plugins/providers/builtin/`. The managed llama.cpp runtime currently under `packages/core/src/llm/local/` will move to `packages/core/src/plugins/providers/llama-cpp/runtime/`, including its platform-native runtime assets and vendor sources.

The shared LLM contracts, provider registry, transport, health checks, and adapters under `packages/core/src/llm/provider/` remain Core infrastructure because `agent.ts`, the API layer, control adapters, and the model router consume them directly. The `packages/core/src/local/local-runtime.ts` file remains only as a compatibility facade and will point to the Plugin-owned runtime; it is not an independent implementation.

The actual memory engine in `packages/memory/` remains outside the Plugin folder. It is a separately versioned `@miki/memory` package with its own package manifest, CommonJS runtime, SQLite-backed implementation, and test suite. Only the Core memory adapter and its type declarations belong under `packages/core/src/plugins/memory/`. The obsolete `packages/core/src/memory/memory-bridge.ts` bridge was removed after internal imports were redirected to the Plugin memory runtime; the remaining `packages/core/src/memory/memory-governance.ts` policy module stays in Core because retention, redaction, scope, and access rules are core governance, not a pluggable memory backend. Likewise, `packages/skills/` remains a separately versioned pre-bundled skills package, not a runtime Plugin implementation.

## Migration rules

All moves will use Git-aware renames. Internal imports, TypeScript exclusions, compatibility facades, tests, and comments will be updated to the new canonical paths. No new duplicate implementation will be created, and no external memory or skills package will be copied into Core Plugins.

The final verification must prove that no provider or local-runtime implementation remains under the old `llm/provider/Plug-in` or `llm/local` paths, that the obsolete `core/src/memory/memory-bridge.ts` path is gone, and that the intentionally retained Core memory-governance module plus separate `packages/memory` and `packages/skills` packages continue through their existing boundaries.

## Final move map

| Area                                                           | Final location                                           | Decision                                                  |
| -------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Built-in Gemini and llama.cpp provider implementations         | `packages/core/src/plugins/providers/builtin/`           | Moved into Plugin ownership.                              |
| Managed llama.cpp runtime and native assets                    | `packages/core/src/plugins/providers/llama-cpp/runtime/` | Moved into the local provider Plugin.                     |
| Provider SDK, registry, transport, health, and shared adapters | `packages/core/src/llm/provider/`                        | Kept in Core because multiple Core services consume them. |
| Local runtime compatibility export                             | `packages/core/src/local/local-runtime.ts`               | Kept as a thin backward-compatible facade only.           |
| Memory Plugin adapter and type boundary                        | `packages/core/src/plugins/memory/`                      | Canonical Plugin integration.                             |
| Durable memory engine                                          | `packages/memory/`                                       | Kept as the separately versioned `@miki/memory` package.  |
| Pre-bundled Agent Skills                                       | `packages/skills/`                                       | Kept as the separately versioned `@miki/skills` package.  |

The migration invariant is that each runtime implementation has one canonical location. Compatibility facades may remain only when they preserve a public or cross-package contract and must contain no duplicate implementation.

## Final verification result

The final repository-wide verification passed. Core, gateway, installer, skills, and memory package builds and typechecks completed successfully; the full Jest and Vitest suites passed with 100 Jest suites and 581 tests plus 15 frontend test files and 68 tests. The doctor check passed with only the existing optional Gemini credential warning.

The old provider implementation path, old local runtime path, and obsolete Core memory bridge are absent. The Core `memory-governance.ts` policy module, the separately versioned `packages/memory` engine, and the separately versioned `packages/skills` package remain intentionally outside Plugin implementation ownership.
