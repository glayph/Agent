# Miki Monitoring Graph — Implementation & Verification Report

**Date:** 2026-11-04  
**Scope:** Monitoring live execution graph repair, terminal-node lifecycle, Tool/Plugin icon presentation.

## Implemented

### 1. Explicit semantic graph connections
- Removed the frontend's level-based edge inference. `level` is now a layout hint only.
- Backend `node.spawn` events carry explicit `parent_node_ids` for the Root Goal, Plan steps, Tool calls and system phases.
- Tool nodes attach to the owning active Plan step when the engine provides a `planStepId`; otherwise they attach to the Run Root. Sibling Tool calls are not connected merely because they share a level.
- Backend history persists dependency edges, updates them when a Plan node is re-emitted, retains late-arriving same-run parents, and rejects known cross-run relationships.
- Frontend resolves late parents, validates same-run relationships, and contracts completed/hidden intermediate nodes to the nearest active ancestor for the live canvas.
- Edge animation now follows active/running states and stops on terminal states.

### 2. Live graph cleanup
- Completed or failed nodes animate out and are removed from the live store after an 800 ms transition.
- The frontend reconnects surviving active children through a display-only continuity edge when a completed intermediate node is removed.
- When a Run ends, the Root Goal briefly reflects its terminal state, all Run edges stop animating, and the entire Run is removed from the live canvas after 900 ms.
- The Gateway's durable diagnostic history is not deleted by visual cleanup.
- History hydration requests active Runs only and does not restore old terminal Runs to the live canvas.

### 3. Tool and Plugin icon metadata
- Added typed monitor presentation metadata to Engine tools.
- Tool Registry assigns category-specific bundled icons for Browser, Computer, Terminal, Files, Memory, Skills, Plugins, MCP and Web Search; tools can also supply an explicit presentation.
- Plugin manifests may specify `monitorIconKey`. Only a fixed set of bundled local icon keys is accepted; remote image URLs and arbitrary markup are rejected.
- The icon key passes through installer validation, registry persistence/reload, runtime plugin catalog and Gateway monitor events.
- Monitor nodes render their trusted `iconKey` from the frontend's local icon registry, with a type-based fallback for older events.

### 4. Compatibility and tests added/updated
- Added additive SQLite migration columns for icon and tool/plugin/provider presentation metadata. Existing rows are preserved.
- Updated Gateway history, Monitor protocol/store, Tool Registry, Plugin router, installer validator and registry tests.
- Updated API snapshot types and active-only history query.

## Verification performed

| Check | Result |
|---|---|
| TypeScript/TSX syntax transpile of 27 changed modules | PASS |
| Real frontend Store/Protocol smoke: explicit dependency + icon metadata | PASS |
| Real frontend Store/Protocol smoke: late-arriving parent | PASS |
| Real frontend Store/Protocol smoke: completed-node removal + graph contraction | PASS |
| Real frontend Store/Protocol smoke: complete-run cleanup | PASS |
| Real frontend Store/Protocol smoke: active-run hydration through completed intermediary | PASS |
| Real frontend Store/Protocol smoke: terminal edge animation | PASS |
| Real Tool Registry category icon mapping | PASS |
| Real Tool Registry custom Plugin icon metadata | PASS |
| SQLite additive migration + dependency/presentation persistence checks | PASS |
| SQLite terminal edge-animation/history-retention check | PASS |
| `package-lock.json` compared with source baseline | UNCHANGED |

## Build/test limitation

A full dependency-backed build and Jest/Vitest suite could not be completed in this execution environment.

- The environment has Node.js `22.16.0`; the project declares a minimum of `22.19.0`.
- `npm install` did not finish because the package registry request failed with DNS/network error `EAI_AGAIN`.
- `npm run build:all` was attempted and stopped at the native SQLite preflight because `better-sqlite3` was not installed (`Cannot find package .../node_modules/better-sqlite3/index.js`).
- Therefore this report does **not** claim that the full project type-check, unit-test suite, production build or UI runtime passed.

## Files/areas changed

- `packages/core/src/engine`: monitor presentation types, tool classification, tool/plan association.
- `packages/core/src/plugins/sdk`: plugin manifest icon metadata.
- `packages/core/src/plugins/skills/installer/src`: allowlisted icon validation and persisted plugin metadata.
- `packages/gateway/src`: graph event generation, plugin metadata resolution, SQLite history migration/persistence and API snapshot output.
- `packages/ui/frontend/src/features/monitor`: semantic edges, graph hydration, terminal cleanup, continuity edges, node visuals and metadata types.
- Corresponding tests were updated or added in the affected packages.

## Runtime behavior summary

`Run Root → Plan dependency graph → Tool/Plugin child nodes` is the semantic graph. Completed nodes animate out and disappear from the live canvas; completed historical records remain in Gateway storage. Tool and Plugin nodes use local bundled icons based on trusted runtime/manifest metadata.
