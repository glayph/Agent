# Miki Monitoring Graph Repair & Live-Node Lifecycle Plan

**Status:** Investigation and implementation plan only  
**Project snapshot inspected:** `Miki-AutonomousAiAgent-Implemented.zip` / current `miki_review` source  
**Scope:** Monitoring Page graph connections, completed-node lifecycle, and per-tool/plugin icons  
**Important:** No runtime/source implementation changes are made in this task. This document records the observed causes and proposed implementation.

---

## 1. Objective

Make the Monitoring Page a true **Live Execution Graph**:

1. Every visible activity belongs to a run/goal and has an explicit relationship to its parent or prerequisite.
2. Edges represent real execution/dependency relationships, not inferred adjacency from numeric levels.
3. Completed activity nodes leave the live canvas automatically; a completed run leaves no stale graph behind.
4. Tool, browser, terminal, computer, memory, skill, plugin, MCP, file, workflow, and system activities render the correct icon from trusted runtime metadata.
5. Diagnostic/history data remains available separately; removing a node from the live canvas must not silently delete execution history.

## 2. Source-inspection findings and root causes

### 2.1 Disconnected nodes: the live and persisted graph use different algorithms

**Frontend:** `packages/ui/frontend/src/features/monitor/protocol.ts`

- `buildEdgesForLevel()` (around lines 66–88) creates edges by searching every node at `level - 1`.
- `node.spawn` (around lines 134–175) calls that helper and does not read `payload.depends_on`.
- Level zero nodes always receive no edge. Multiple tool calls in one model turn are emitted at the same level, so they appear as disconnected peers.
- The all-to-all previous-level heuristic can also invent relationships that are not present in the plan.

**Backend emitter:** `packages/gateway/src/agent-runtime.ts`

- `emitMonitorPlan()` (around lines 2683–2723) computes real dependency depths and sends explicit `depends_on` for plan-step nodes.
- `emitMonitorToolCall()` (around lines 2633–2681) emits the tool node's `level` but does not emit a parent/dependency ID.
- Consequently, tool activities in the same turn have no real dependency information in the event contract.

**Backend persistence:** `packages/gateway/src/monitor-history.ts`

- `safeEvent("node.spawn")` accepts and sanitizes `depends_on` (around lines 125–133).
- `persistMonitorEvent()` inserts `monitor_edges` only for supplied `depends_on` IDs (around lines 184–194).
- It does not reproduce the Frontend's `level - 1` inference.

Therefore, a graph can appear connected during one live session due to the Frontend heuristic, but the same edges are absent after history hydration/reload. This is a direct live-vs-persisted graph consistency bug.

### 2.2 Completed nodes remain visible by design

**Frontend event handler:** `packages/ui/frontend/src/features/monitor/protocol.ts`

- `node.complete` changes a node to `completed` or `failed`, but does not remove it.
- `node.run_end` only changes the Run status and timestamp.
- A comment around lines 275–277 explicitly says terminal runs are kept in session monitor history so the inspector can continue showing details.

**Store:** `packages/ui/frontend/src/features/monitor/store.ts`

- `updateMonitorStore()` retains up to `MAX_IN_MEMORY_COMPLETED_RUNS = 100` completed runs.
- Local history persists metadata for recent runs/nodes.
- These are history-retention rules, not a live-canvas lifecycle.

**Backend:** `packages/gateway/src/monitor-history.ts`

- Terminal history is retained by `pruneMonitorHistory()` (30-day default and per-session run cap).
- `/api/monitor/history` returns historical runs and their nodes/edges.
- `MonitorWorkspace` hydrates that history directly into the same store used for live graph rendering.

This mixes two different concerns: a live activity canvas and historical diagnostics. There is currently no automatic live-node expiry/cleanup policy.

### 2.3 Tool/plugin icons are category-wide, not activity-specific

**Icon map:** `packages/ui/frontend/src/features/monitor/node-visuals.constants.ts`

- `NODE_TYPE_ICON` maps each of the seven current node categories to one generic icon.
- All `tool` nodes share `IconTool`; all `plugin` nodes share `IconPlugConnected`.

**Node renderer:** `packages/ui/frontend/src/features/monitor/agent-node.tsx`

- The icon is selected only by `NODE_TYPE_ICON[node.type]`.
- No tool name, provider, plugin ID, or presentation icon key is considered.

**Classification:** `packages/ui/frontend/src/features/monitor/protocol.ts`

- `inferNodeType()` uses label-prefix/substring heuristics.
- `MonitorNodeType` currently contains only `tool`, `skill`, `plugin`, `file`, `command`, `pattern`, and `system`; Browser, Computer, MCP, Memory, Web Search, Goal, etc. have no first-class type.
- Browser/computer/MCP tools can therefore fall through to the generic `tool` category.

**Runtime metadata contracts:**

- `packages/core/src/engine/types.ts` defines `EngineTool`, but it has no monitor presentation metadata such as `category`, `displayName`, or `iconKey`.
- `packages/core/src/plugins/sdk/index.ts` defines `PluginManifest`, but it has no dedicated monitor icon field (only an open-ended `metadata` record).
- Tool events are mapped in `createWsEventMapper()` and currently carry the name/label, not a trusted presentation descriptor.

The frontend cannot render a tool-specific icon reliably because the runtime does not send a canonical icon identity.

---

## 3. Target architecture

### 3.1 One canonical graph event contract

Create a shared monitor activity presentation/relationship contract. A `node.spawn` event should carry, where known:

```ts
{
  run_id: string,
  node_id: string,
  label: string,
  node_type: MonitorNodeType,
  icon_key: string,
  display_name?: string,
  tool_name?: string,
  plugin_id?: string,
  provider_id?: string,
  parent_node_ids: string[],
  level?: number,
  parallel?: boolean,
  status: MonitorNodeStatus
}
```

Rules:

- `parent_node_ids` is the graph source of truth. It is derived from actual plan dependencies, the plan step that owns a tool call, and/or the run root.
- `level` is layout metadata only. It must never be used to invent a dependency edge.
- If an activity has no explicit plan parent, connect it to a synthetic run-root node (or another explicit run-level anchor) so independent parallel work is still visually grouped under the same run.
- A node may have multiple parents when the plan genuinely has multiple prerequisites.
- IDs must be scoped to the current run; reject cross-run, self, and malformed edges.
- Duplicate edges must be idempotent.
- If a parent arrives after its child, retain the unresolved reference and resolve it when the parent is received; do not silently discard the relationship.

### 3.2 Connect tool calls to real plan steps

The Agent Engine already has `PlanStep.dependsOn`, and `markPlanRunning()` identifies a plan step when a tool starts. The current tool-call event does not expose that association.

Proposed change:

- Extend the tool-call/monitor event provenance with the owning `planStepId` (and, where relevant, plan-step parent IDs).
- Make the plan-step association deterministic for the current run. Avoid a new Frontend guess based on matching names or turn numbers.
- `emitMonitorPlan()` maps plan-step IDs to stable node IDs.
- `emitMonitorToolCall()` connects a tool activity to its owning plan-step node. A run-root connection is used if no plan-step association exists.
- Parallel tool calls under one plan step become siblings. They must not be artificially connected to one another.

### 3.3 Backend and Frontend must use the same edge records

- Backend `safeEvent()` validates and persists `parent_node_ids` (or the chosen canonical dependency field).
- `monitor_edges` remains the durable normalized representation of those parent/child relationships.
- History responses return the same edge set the live Frontend uses.
- Frontend `protocol.ts` consumes the explicit IDs and does not call `buildEdgesForLevel()`.
- `hydrateMonitorHistory()` restores only validated edges for the graph snapshot; history hydration must not regenerate different edges.
- Include a schema/data migration only if the final contract requires new columns. If relationship IDs can be represented in the existing edge table and event payload, avoid unnecessary schema changes.

---

## 4. Live node lifecycle and cleanup

### 4.1 Separate live graph from diagnostic history

Do not delete monitor history just to make the canvas clean.

- **Live canvas state:** only the active run's currently relevant nodes and edges.
- **Historical diagnostic state:** persisted run/event/trace information, accessible through the existing authenticated history/trace API or a future history surface.
- `MonitorWorkspace` must not hydrate dozens of terminal runs into the same graph that receives live `node.*` events.

### 4.2 Node-level lifecycle

Recommended sequence:

1. `node.spawn`: create a live node with a stable identity and explicit parents.
2. `node.update`: update running/retrying/pending status.
3. `node.complete`: briefly show a completed/failed state and a short transition animation.
4. Once the node is no longer needed to represent active work, remove it from the live node/edge store and clear selection/inspector references.
5. Keep the terminal event and safe metadata in backend history.

A completion delay should be a small UI transition, not a long retention period. The exact animation interval can be tuned during UI testing (initial proposal: approximately 600–1,000 ms).

### 4.3 Preserve a coherent graph while removing finished nodes

Removing a completed predecessor must not make the remaining active graph appear broken.

- Keep the run-root/active plan anchors visible while the run is active.
- When a completed intermediate node is removed, re-anchor its still-active descendants to the nearest surviving active plan ancestor or run root using **display-only visual edges**.
- Do not rewrite the backend's semantic dependency history to create these visual bridge edges.
- When no active descendants depend on a completed node, remove it immediately after its transition.
- Parallel branches remain grouped under their shared parent/root.

### 4.4 Run-level cleanup

On `node.run_end`:

- Finalize any still-open node as terminal/failed according to the real run status.
- Show a brief run-completion/failure transition.
- Clear all nodes, edges, selected node/run and inspector state for that run from the live canvas.
- Reset the canvas to its empty state until another run starts.
- Do not delete the server-side diagnostic history or the chat conversation.

### 4.5 Hydration and stale-event protection

- The live view should display active runs only, not all recently completed history.
- A reconnect should hydrate active nodes and their edges so an in-progress graph is restored.
- A delayed event for a run already finalized must not recreate a stale live graph.
- Keep a bounded terminal-run tombstone/sequence guard in the Frontend to ignore late events after cleanup.
- Clear inspector selection when its node is removed.

---

## 5. Tool/plugin-specific icon system

### 5.1 Canonical presentation metadata

Add optional trusted presentation metadata to runtime registration contracts, rather than inferring icons from arbitrary labels.

Suggested `EngineTool` metadata:

```ts
monitor?: {
  category: "tool" | "browser" | "computer" | "terminal" | "file" |
            "memory" | "skill" | "plugin" | "mcp" | "search" |
            "goal" | "workflow" | "system";
  displayName?: string;
  iconKey: string;
  pluginId?: string;
  providerId?: string;
}
```

For plugin manifests, add a validated `monitorIconKey` (or a nested presentation field). It should resolve to a known local icon key. A remote URL supplied by a plugin must not be rendered as executable markup or fetched without a separate trusted asset policy.

### 5.2 Icon registry

Create a central icon registry mapping stable string keys to bundled Tabler icon components and approved brand assets.

Initial categories:

| Runtime capability | Default icon key | Fallback |
|---|---|---|
| Browser / web navigation | `browser` | `tool` |
| Web search | `search` | `tool` |
| Terminal / shell | `terminal` | `tool` |
| Computer use | `computer` | `tool` |
| Filesystem | `file` / `folder` | `tool` |
| Memory | `memory` | `tool` |
| Skill | `skill` | `tool` |
| Plugin | plugin-provided key | `plugin` |
| MCP | `mcp` | `tool` |
| Goal / task | `goal` | `system` |
| Workflow / planner | `workflow` | `system` |
| System phase | `system` | `tool` |

Where an installed plugin has a known brand icon (for example a CRM or productivity integration), use its registered `iconKey`. Unknown/custom plugins receive a consistent plugin fallback icon plus their display name; do not make up a brand icon.

### 5.3 Event-to-render pipeline

1. Tool Registry supplies the tool's monitor metadata.
2. Plugin host/manifest supplies plugin identity and icon metadata where available.
3. `createWsEventMapper()` enriches `node.spawn` with trusted display/type/icon fields.
4. Backend validates and persists the allowlisted fields.
5. Frontend stores `iconKey` and resolves it through the central registry.
6. `AgentNode` renders the specific icon, with category fallback and unknown-tool fallback.

The same icon resolver must be used in both minimized and expanded node states and in the inspector.

---

## 6. Files expected to change during implementation

### Core/runtime contracts

- `packages/core/src/engine/types.ts` — add optional tool presentation metadata and/or plan-step provenance to tool-call records/events.
- `packages/core/src/engine/agent-engine.ts` — expose the actual owning plan-step ID when a tool call starts; keep semantic dependency data deterministic.
- `packages/core/src/engine/tool-registry.ts` — preserve and expose registered monitor metadata through registry lookup.
- `packages/core/src/plugins/sdk/index.ts` — add validated optional plugin icon/presentation metadata.

### Gateway event production and persistence

- `packages/gateway/src/agent-runtime.ts` — emit run-root/plan/tool nodes with explicit parents and presentation metadata; map tool names to their registered metadata rather than frontend prefix guesses.
- `packages/gateway/src/chat-turn-runner.ts` — pass an explicit metadata resolver into the WebSocket event mapper if that is the cleanest ownership boundary.
- `packages/gateway/src/monitor-history.ts` — sanitize, persist and return canonical relationships/presentation fields; preserve history when live UI nodes expire.
- `packages/gateway/src/monitor-history.test.ts` — verify dependency edge persistence, icon metadata validation, history hydration and pruning compatibility.

### Frontend monitor

- `packages/ui/frontend/src/features/monitor/store.ts` — add icon/presentation fields and explicit live-run lifecycle/cleanup actions; separate live state from historical records.
- `packages/ui/frontend/src/features/monitor/protocol.ts` — consume explicit parents; remove level-based edge inference; handle node/run cleanup and late events.
- `packages/ui/frontend/src/features/monitor/layout.ts` — layout from canonical edges only; use level only as a layout hint if still required.
- `packages/ui/frontend/src/features/monitor/node-visuals.constants.ts` — replace category-only icon map with central icon-key registry and safe fallbacks.
- `packages/ui/frontend/src/features/monitor/agent-node.tsx` — render the resolved per-tool/per-plugin icon.
- `packages/ui/frontend/src/features/monitor/monitor-canvas.tsx` — render active graph only, avoid hydrating completed runs into the live canvas, and clear inspector state after cleanup.
- `packages/ui/frontend/src/features/monitor/flow-edge.tsx` / `monitor.css` — adjust edge/transition styling if needed; visual polish follows data correctness.

Existing tests to extend:

- `packages/ui/frontend/src/features/monitor/protocol.test.ts`
- `packages/ui/frontend/src/features/monitor/store.test.ts`
- `packages/ui/frontend/src/features/monitor/history-api.test.ts`
- `packages/gateway/src/monitor-history.test.ts`

---

## 7. Implementation phases

| Phase | Work | Deliverable |
|---|---|---|
| 0 | Baseline tests and event-contract audit | Reproducible failing tests for all three symptoms |
| 1 | Canonical graph contract and run-root model | Stable root/parent IDs and validated node metadata |
| 2 | Explicit plan/tool dependency propagation | Live and persisted edges match exactly |
| 3 | Active graph lifecycle | Completed nodes fade/remove; completed runs clear from canvas |
| 4 | Live/history separation | Reload restores active runs only; diagnostic history remains stored |
| 5 | Tool/plugin icon metadata and icon registry | Per-capability/per-plugin icons with deterministic fallback |
| 6 | Layout and visual polish | Clear connected graph, parallel branches, readable node states |
| 7 | Regression/integration verification | Frontend, Gateway, reconnect, restart and lifecycle tests pass |

Do not redesign or remove the Monitoring Page itself. Keep the existing inspector and diagnostic APIs unless a separate requirement explicitly authorizes removing them.

---

## 8. Required acceptance tests

### Connections

- Three nodes at level zero with no direct dependencies do not get arbitrary peer-to-peer edges; each is connected to the run root/explicit plan parent.
- A plan node with `depends_on: [A]` creates exactly `A -> B` in both live state and SQLite history.
- A plan node depending on two prerequisites creates exactly two incoming edges.
- Tool calls are connected to the actual plan step that owns them.
- Parallel tool calls are siblings, not serially connected to one another.
- Same-level and later-turn events never rely on a numeric-level guess.
- Reconnect/history hydration returns the same edge set as the original live graph.
- Cross-run, self, malformed, duplicate and unresolved parent IDs are handled safely.

### Lifecycle

- A completed node shows its terminal state briefly and is then removed from the live canvas.
- Removing a completed parent does not visually disconnect active descendants; display-only re-anchoring does not mutate semantic history.
- `node.run_end` clears all live nodes, edges and inspector selection for that run.
- A new run starts with a clean graph.
- Late events after run cleanup cannot resurrect the previous graph.
- History and trace endpoints still retain the terminal run according to the existing retention policy.
- A page reload during an active run restores the active graph, but reload after completion does not resurrect terminal nodes into the live canvas.

### Icons

- Browser, search, terminal, computer, file, memory, skill, plugin, MCP, goal and system activities each resolve the intended icon.
- Two different plugins can use distinct registered brand icon keys.
- Unknown tool and custom plugin metadata fall back safely; the node never renders without an icon.
- Invalid/untrusted icon keys cannot load arbitrary external markup or executable content.
- Minimized node, expanded node and inspector show the same icon identity.

### Stability and security

- All event fields are schema-validated and bounded.
- Existing redaction of sensitive arguments/results remains unchanged.
- Monitor event persistence failures do not interrupt agent execution.
- Graph cleanup never cancels or modifies the actual agent task.
- The graph is tested with a mixture of plan nodes, tools, plugins, retries, parallel calls, failures and reconnects.

---

## 9. Recommended execution order

Implement the backend contract before polishing the canvas:

1. Add the run-root and explicit parent/dependency IDs.
2. Carry the real plan-step ID into tool-call monitor events.
3. Persist exactly those same edges in Gateway history.
4. Switch Frontend to consume only explicit edges and add contract tests.
5. Separate live graph state from retained diagnostic history.
6. Add node/run cleanup and late-event protection.
7. Add trusted tool/plugin presentation metadata and the icon registry.
8. Verify all three requested symptoms with the acceptance tests above.

This order prevents a UI-only repair from appearing correct during one WebSocket session but breaking after reconnect or page reload.
