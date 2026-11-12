# Monitoring topology repair — 2026-11-06

## Scope

This change set repairs monitoring graph persistence and historical inspection without removing existing monitor features.

## Findings and fixes

1. **Completed history was not actually reachable from the canvas.** The initial monitor hydration requested only active runs, and the older-history pagination request inherited the same `active_only=1` default. The canvas now hydrates the first page from all persisted runs and explicitly requests non-active pages when loading older history. Hydration can include terminal runs/nodes for history while retaining the active-only default for other callers.
2. **Terminal nodes disappeared too quickly.** The live graph cleanup window was 900 ms. It is now 60 seconds, while the durable server history remains the long-term source of truth.
3. **Failure details were discarded by the history allowlist.** A bounded `error` field is now sanitized and persisted on failed node completion, returned by history/trace APIs, and restored to the node inspector. API keys, common credential assignments, and `sk-`-style tokens are redacted. Raw inputs, outputs, objectives, and action payloads remain excluded.
4. **Historical node diagnostics were missing from the client DTO/hydrator.** The API response type and history hydration now preserve the sanitized error string.
5. **Agent nodes were not in the server allowlist.** `agent` is now accepted as a monitor node type.
6. **Dependency cycles could be persisted.** Before inserting a dependency edge, the server checks whether the edge would close a directed cycle and rejects only that invalid edge. Existing valid edges and late-arriving same-run parent resolution are preserved.

## Files changed

- `packages/gateway/src/monitoring/monitor-history.ts`
- `packages/gateway/src/monitoring/monitor-history.test.ts`
- `packages/ui/frontend/src/features/monitor/history-api.ts`
- `packages/ui/frontend/src/features/monitor/history-api.test.ts`
- `packages/ui/frontend/src/features/monitor/monitor-canvas.tsx`
- `packages/ui/frontend/src/features/monitor/protocol.ts`
- `packages/ui/frontend/src/features/monitor/store.ts`
- `packages/ui/frontend/src/features/monitor/store.test.ts`

## Verification

- ZIP integrity is checked after packaging.
- Full TypeScript project build and automated tests could not be completed in this environment because dependencies/type packages are not installed. The repository requires Node.js `>=22.19.0`; the available runtime is `22.16.0`.
- Run the project checks in a supported environment after `npm install`:
  - `npm run build:all`
  - `npm run test --workspace=@miki/gateway -- src/monitor-history.test.ts` (or the workspace's equivalent test command)
  - `npm --prefix packages/ui/frontend run test -- --run src/features/monitor/history-api.test.ts src/features/monitor/store.test.ts`

## Data migration

The new `monitor_nodes.error` column is added idempotently at startup via `PRAGMA table_info` + `ALTER TABLE`, so existing SQLite databases are upgraded without deleting prior history.

## Maintenance and status note

This is a dated investigation, plan, or implementation snapshot. Its findings and status labels describe the code and test evidence available when it was written; they are not a live assertion that every item remains current. Preserve this report as historical context. For present behavior, check the current source, the adjacent tests, and [Agent-Miki Operating Model](AGENT_MIKI_OPERATING_MODEL.md) where applicable. Do not treat an unverified recommendation or an old checklist as proof of an enabled capability.
