# Mem0 Removal — Fully Local Memory

**Date:** 2026-10-03  
**Change:** Complete removal of Mem0 as a memory backend.

## What was removed

- Dependency `mem0ai` from `@miki/memory`
- Exports and requires for `mem0-adapter` / `Mem0OnlyIntegration` (modules were already missing from the tree)
- Runtime bridge that forced `Mem0OnlyIntegration` and stubbed TKG APIs
- Plugin id `memory.mem0` → replaced by `memory.local-tkg`
- Launcher health probes for `memory/vectors.db` + `memory/history.db`

## What is used instead

| Layer | Implementation |
|-------|----------------|
| Semantic / event / graph | Local **Temporal Knowledge Graph** (`memory/tkg.db`) via `AgentMemoryIntegration` |
| Durable notes / compaction | **FileMemoryService** (`MEMORY.md`, daily notes, WAL writer) |
| Selective / multi-hop | TKG + SelectiveMemoryEngine + MultiHopRetriever (local SQLite) |

## Code touch points

- `packages/core/src/memory/runtime.ts` — init/close/backup against TKG
- `packages/core/src/memory/plugin.ts` — local-tkg plugin
- `packages/memory/src/agent-memory-integration.js` — Mem0 adapter usage removed
- `packages/memory/src/index.js` + `package.json` — no Mem0 exports/deps
- `packages/core/src/api/launcher-compat.ts` — probes `memory/tkg.db`

## Operator notes

- First start creates `dataDir/memory/tkg.db` (SQLite, better-sqlite3).
- File memory under identity / scopes is unchanged.
- No Gemini / Mem0 cloud API required for core memory.

## Post-removal verification fixes (2026-10-03)

| Issue | Fix |
|-------|-----|
| `getEnhancedSystemPrompt` used `.split('\\n')` (literal backslash-n) | Split on real newlines; guard non-string `contextWindow` |
| `closeMemory` closed the same TKG twice | Close `_tkg` once only |
| `getSelectiveMemoryStats` called missing `getStats` | Call `selectiveMemory.stats()` |
| Agent shutdown left TKG SQLite open | `closeMemory()` from `stopBackgroundTasks` and `close()` |
| Graph ingest failure could break interaction logging | try/catch around graph ingest; TKG events retained |
| Types lagged constructors | `TemporalKnowledgeGraph` / `AgentMemoryIntegration` options in `types.d.ts` |
