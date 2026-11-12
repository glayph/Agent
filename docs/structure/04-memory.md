# 04 — packages/memory (Persistent Memory)

`@miki/memory` owns Miki's persistent memory implementations and exports them through package entry points. It includes both the Temporal Knowledge Graph (TKG) subsystem and complementary file-backed memory tools.

## Current source domains

```text
packages/memory/src/
├── core/          # Shared memory contracts, runtime bridge and global-memory adapters
├── file-memory/   # File-backed notes, search, compaction and memory tooling
└── test/          # Package-level memory tests and runners
```

Additional top-level implementation modules in the package provide graph storage/retrieval, temporal relationships, consolidation, embeddings, working/temporary memory, selective retention, learning, and integration helpers. The exact file inventory should be read from the current package rather than copied from an older generated tree.

## Concepts

- **Temporal Knowledge Graph:** stores time-aware entities, facts and relationships where supported by the configured memory implementation.
- **File memory:** stores searchable, human-readable notes and related artifacts through a distinct subsystem.
- **Working/temporary context:** supports short-lived context without treating every observation as durable truth.
- **Consolidation and selective retention:** maintain memory according to configured retention and importance policies.
- **Retrieval:** searches relevant memory for task context; retrieved content remains fallible and must be checked against current evidence.

## Ownership and safety

All persistent memory implementations belong under `packages/memory/`. Core and Gateway consume the exported API; do not create a duplicate memory store under `packages/core/src/` or `packages/gateway/src/`.

Memory improves continuity but does not grant authority, prove a statement, or override the current owner request/runtime policy. Store durable, useful, non-secret facts only. Do not store credentials or sensitive information merely because it appeared in a task.

Run the memory package's own tests and relevant Core/Gateway integration tests after changing storage, retrieval, retention or prompt-context behavior.
