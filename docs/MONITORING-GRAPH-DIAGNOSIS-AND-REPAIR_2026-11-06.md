# Miki Monitoring Graph — Diagnosis and Repair

**Date:** 2026-11-06  
**Scope:** Monitoring page node connectivity, dependency semantics, live graph construction and historical hydration.

## Diagnosis

### P1 — A child can become disconnected when its declared parent never materializes

`packages/ui/frontend/src/features/monitor/protocol.ts` resolved a node's `parentNodeIds` only when the referenced parent already existed or had been recorded as a pruned node. If a child referenced a same-run planner node that was never emitted (for example, a stale/replaced planner step ID), `resolveVisibleParents()` returned an empty array. `rebuildRunEdges()` then emitted no edge, leaving the child floating despite the run root being present.

This was a live-graph gap. The history hydration path already had a run-root fallback, so live and hydrated graph behavior could differ.

### P1 — Tool completion order was being treated as a dependency

`packages/gateway/src/agent/agent-runtime.ts` appended `lastCompletedMonitorToolByRun` to the next tool's `parent_node_ids`. Completion order does not prove dependency: independent plan steps, retries and interleaved/parallel tool calls can complete in an order unrelated to their actual prerequisites. This could draw false tool-to-tool edges and make the graph misleading.

### P2 — A full build and browser-level reproduction are not available in this environment

The uploaded source contains no installed dependencies. The current environment has Node.js 22.16.0, below the root project's declared Node.js minimum of 22.19.0. Therefore this repair is syntax-checked, not fully build- or browser-verified.

## Repairs

1. `resolveVisibleParents()` now anchors a child to `${runId}:root` when none of its declared parents can currently be resolved. The fallback is marked `displayOnly` and is recomputed on each node spawn. When the real parent later arrives, the semantic parent edge replaces the temporary root edge.
2. Tool nodes now use only their explicit owning planner step as a semantic parent, or the run root when no `planStepId` exists. The completion-order edge heuristic and its per-run map were removed because they represented inferred rather than verified dependencies.
3. Added a protocol regression test proving both fallback behavior and replacement by a late-arriving real parent.

## Expected graph behavior

- Every non-root live node remains visually anchored to its run root if its declared parent is missing.
- When the declared same-run parent arrives, the temporary root edge is removed and the real dependency edge is shown.
- Independent tool calls are not connected merely because one completed before another started.
- Plan dependency edges remain explicit; numeric `level` remains a layout hint only.
- Cross-run references remain rejected by the frontend's parent validation.

## Verification

| Check | Result |
|---|---|
| TypeScript transpile/syntax check: `protocol.ts` | PASS |
| TypeScript transpile/syntax check: `protocol.test.ts` | PASS |
| TypeScript transpile/syntax check: `agent-runtime.ts` | PASS |
| Regression test added for unresolved-parent fallback and late-parent replacement | ADDED; not executed |
| Full frontend test suite | NOT RUN — dependencies not installed |
| Full monorepo build | NOT RUN — dependencies not installed and Node.js below root minimum |
| Browser/production runtime | NOT RUN — no live Gateway/browser deployment available |

## Files changed

- `packages/ui/frontend/src/features/monitor/protocol.ts`
- `packages/ui/frontend/src/features/monitor/protocol.test.ts`
- `packages/gateway/src/agent/agent-runtime.ts`
- `docs/MONITORING-GRAPH-DIAGNOSIS-AND-REPAIR_2026-11-06.md`

No existing Monitoring page feature was removed. Only an unverified completion-order relationship heuristic was removed; the actual planner dependency and run-root relationships remain.
