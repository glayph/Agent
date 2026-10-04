# Autonomy Step 1 — Durable Runs Store

**Status:** implemented (observable foundation)

## What changed

1. **`packages/gateway/src/runs-store.ts`**
   - `RunsStore` (SQLite table `agent_runs`)
   - `createRunsRouter` → `GET /api/runs`, `GET /api/runs/stats`, `GET /api/runs/:id`
   - Filters: `status`, `lane`, `q`, `page` / `limit` / `offset`
   - Lane mapping from source string (`chat` | `heartbeat` | `autonomy` | `control`)

2. **`packages/gateway/src/agent-runtime.ts`**
   - Every `startRun` inserts a `running` row
   - Every completion / failure calls `finish` with status, goal, usage, tool counts
   - Optional `lane` on `startRun` for future autonomy/heartbeat
   - Exposes `runsStore` on the runtime object

3. **`packages/gateway/src/index.ts`**
   - `/api/agents` and `/api/swarm/status` read live counts from `runsStore` (no longer empty stubs)

4. **UI**
   - `packages/ui/frontend/src/api/runs.ts` — client
   - `packages/ui/frontend/src/features/agent/runs/runs-page.tsx` — live list with filters and pagination

5. **Mirror**
   - `packages/core/src/api/runs-router.ts` (same store; for later package export)

## Verification

- Unit: `packages/gateway/src/runs-store.test.ts`
- Manual: start gateway → chat once → `GET /api/runs` shows a row → `/agent/runs` lists it

## Next (Step 2)

HeartbeatService timer only (metrics + lifecycle events, no tools yet).
