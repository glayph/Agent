import { atom, getDefaultStore } from "jotai"

/**
 * Node graph store for the Smart Work Monitoring canvas.
 *
 * This is intentionally decoupled from `@/store/chat`: the monitor reflects
 * live agent execution (tool calls, plugins, skills, system working
 * patterns), not the conversational transcript. It is fed exclusively by
 * `node.*` websocket messages relayed from the same `/miki/ws` connection
 * the chat feature already owns (see features/monitor/protocol.ts).
 */

export type MonitorNodeStatus =
  "pending" | "running" | "retrying" | "completed" | "failed"

export type MonitorNodeType =
  "tool" | "skill" | "plugin" | "file" | "command" | "pattern" | "system"

export type MonitorNodeUIState = "minimized" | "expanded"

export interface MonitorNode {
  id: string
  runId: string
  type: MonitorNodeType
  label: string
  status: MonitorNodeStatus
  /** Execution "wave" from the planner — used to place columns and infer edges. */
  level: number
  parallel: boolean
  input?: unknown
  action?: string
  resultMessage?: string
  outputPreview?: string
  attempt?: number
  durationMs?: number
  error?: string
  createdAt: number
  updatedAt: number
  /** Position is owned by the layout engine unless the user or agent moves it. */
  position?: { x: number; y: number }
  uiState: MonitorNodeUIState
  /** True once the agent (or layout engine) has assigned this an explicit position. */
  hasManualPosition?: boolean
}

export interface MonitorEdge {
  id: string
  source: string
  target: string
  runId: string
  /** Active while data/control is actually flowing between the two nodes. */
  animated: boolean
}

export interface MonitorRun {
  id: string
  objective?: string
  status: "running" | "completed" | "failed"
  startedAt: number
  endedAt?: number
  planTotal?: number
  planLevels?: number
  accelerationMode?: string
  speedClass?: string
}

export interface MonitorState {
  runs: Record<string, MonitorRun>
  nodes: Record<string, MonitorNode>
  edges: Record<string, MonitorEdge>
  /** Order nodes were spawned in, for stable fallback layout. */
  nodeOrder: string[]
  /** Shared focus between chat activity affordances and the monitor surface. */
  selectedRunId?: string
  selectedNodeId?: string
}

const MONITOR_HISTORY_STORAGE_KEY = "miki.monitor.history.v1"
const MAX_PERSISTED_NODES = 500
const MAX_IN_MEMORY_COMPLETED_RUNS = 100

function emptyMonitorState(): MonitorState {
  return {
    runs: {},
    nodes: {},
    edges: {},
    nodeOrder: [],
    selectedRunId: undefined,
    selectedNodeId: undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function safePosition(value: unknown): { x: number; y: number } | undefined {
  if (!isRecord(value) || !finiteNumber(value.x) || !finiteNumber(value.y)) return undefined
  return { x: value.x, y: value.y }
}

/**
 * Persist only operational metadata. Tool inputs, results, output previews,
 * errors, actions and user objectives may contain sensitive material and are
 * intentionally excluded from browser storage.
 */
export function serializeMonitorHistory(state: MonitorState): string {
  const orderedRuns = Object.values(state.runs).sort(
    (left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt),
  )
  const persistedRuns = orderedRuns.slice(0, 12)
  const runIds = new Set(persistedRuns.map((run) => run.id))
  const persistedNodes = Object.values(state.nodes)
    .filter((node) => runIds.has(node.runId))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_PERSISTED_NODES)
  const nodes = Object.fromEntries(persistedNodes.map((node) => [node.id, {
    id: node.id,
    runId: node.runId,
    type: node.type,
    label: node.label,
    status: node.status,
    level: node.level,
    parallel: node.parallel,
    ...(node.attempt != null ? { attempt: node.attempt } : {}),
    ...(node.durationMs != null ? { durationMs: node.durationMs } : {}),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    ...(safePosition(node.position) ? { position: safePosition(node.position) } : {}),
    uiState: node.uiState,
    ...(node.hasManualPosition ? { hasManualPosition: true } : {}),
  }]))
  const nodeIds = new Set(Object.keys(nodes))
  const runs = Object.fromEntries(persistedRuns.map((run) => [run.id, {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.endedAt != null ? { endedAt: run.endedAt } : {}),
    ...(run.planTotal != null ? { planTotal: run.planTotal } : {}),
    ...(run.planLevels != null ? { planLevels: run.planLevels } : {}),
    ...(run.accelerationMode ? { accelerationMode: run.accelerationMode } : {}),
    ...(run.speedClass ? { speedClass: run.speedClass } : {}),
  }]))
  const edges = Object.fromEntries(Object.values(state.edges)
    .filter((edge) => runIds.has(edge.runId) && nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => [edge.id, {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      runId: edge.runId,
      animated: edge.animated,
    }]))
  return JSON.stringify({
    runs,
    nodes,
    edges,
    nodeOrder: state.nodeOrder.filter((id) => nodeIds.has(id)),
  })
}

/** Restores a validated, metadata-only snapshot and marks interrupted work. */
export function restoreMonitorHistory(raw: string | null, now = Date.now()): MonitorState {
  if (!raw) return emptyMonitorState()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || !isRecord(parsed.runs) || !isRecord(parsed.nodes)) {
      return emptyMonitorState()
    }
    const runs: MonitorState["runs"] = {}
    for (const [id, value] of Object.entries(parsed.runs)) {
      if (!isRecord(value) || value.id !== id || !finiteNumber(value.startedAt)) continue
      if (value.status !== "running" && value.status !== "completed" && value.status !== "failed") continue
      const interrupted = value.status === "running"
      runs[id] = {
        id,
        status: interrupted ? "failed" : value.status,
        startedAt: value.startedAt,
        ...(finiteNumber(value.endedAt) ? { endedAt: value.endedAt } : interrupted ? { endedAt: now } : {}),
        ...(finiteNumber(value.planTotal) ? { planTotal: value.planTotal } : {}),
        ...(finiteNumber(value.planLevels) ? { planLevels: value.planLevels } : {}),
        ...(typeof value.accelerationMode === "string" ? { accelerationMode: value.accelerationMode } : {}),
        ...(typeof value.speedClass === "string" ? { speedClass: value.speedClass } : {}),
      }
    }
    const validTypes = new Set<MonitorNodeType>(["tool", "skill", "plugin", "file", "command", "pattern", "system"])
    const validStatuses = new Set<MonitorNodeStatus>(["pending", "running", "retrying", "completed", "failed"])
    const nodes: MonitorState["nodes"] = {}
    for (const [id, value] of Object.entries(parsed.nodes)) {
      if (!isRecord(value) || value.id !== id || typeof value.runId !== "string" || !runs[value.runId]) continue
      if (typeof value.label !== "string" || !validTypes.has(value.type as MonitorNodeType) || !validStatuses.has(value.status as MonitorNodeStatus)) continue
      if (!finiteNumber(value.createdAt) || !finiteNumber(value.updatedAt)) continue
      const interrupted = value.status === "pending" || value.status === "running" || value.status === "retrying"
      nodes[id] = {
        id,
        runId: value.runId,
        type: value.type as MonitorNodeType,
        label: value.label,
        status: interrupted ? "failed" : value.status as MonitorNodeStatus,
        level: finiteNumber(value.level) ? value.level : 0,
        parallel: value.parallel === true,
        ...(finiteNumber(value.attempt) ? { attempt: value.attempt } : {}),
        ...(finiteNumber(value.durationMs) ? { durationMs: value.durationMs } : {}),
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        ...(safePosition(value.position) ? { position: safePosition(value.position) } : {}),
        uiState: value.uiState === "expanded" ? "expanded" : "minimized",
        ...(value.hasManualPosition === true ? { hasManualPosition: true } : {}),
      }
    }
    const edges: MonitorState["edges"] = {}
    if (isRecord(parsed.edges)) {
      for (const [id, value] of Object.entries(parsed.edges)) {
        if (!isRecord(value) || value.id !== id || typeof value.source !== "string" || typeof value.target !== "string" || typeof value.runId !== "string") continue
        if (!nodes[value.source] || !nodes[value.target] || !runs[value.runId]) continue
        edges[id] = { id, source: value.source, target: value.target, runId: value.runId, animated: false }
      }
    }
    const nodeOrder = Array.isArray(parsed.nodeOrder)
      ? parsed.nodeOrder.filter((id): id is string => typeof id === "string" && Boolean(nodes[id]))
      : Object.keys(nodes)
    return { runs, nodes, edges, nodeOrder, selectedRunId: undefined, selectedNodeId: undefined }
  } catch {
    return emptyMonitorState()
  }
}

function readMonitorHistory(): MonitorState {
  if (typeof window === "undefined") return emptyMonitorState()
  try {
    return restoreMonitorHistory(window.localStorage.getItem(MONITOR_HISTORY_STORAGE_KEY))
  } catch {
    return emptyMonitorState()
  }
}

function persistMonitorHistory(state: MonitorState) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(MONITOR_HISTORY_STORAGE_KEY, serializeMonitorHistory(state))
  } catch {
    // Storage is optional; the in-memory live monitor must continue to work.
  }
}

const initialState: MonitorState = readMonitorHistory()

export const monitorAtom = atom<MonitorState>(initialState)

const store = getDefaultStore()

export function getMonitorState(): MonitorState {
  return store.get(monitorAtom)
}

export function updateMonitorStore(
  updater:
    Partial<MonitorState> | ((prev: MonitorState) => Partial<MonitorState>),
) {
  const prev = store.get(monitorAtom)
  const patch = typeof updater === "function" ? updater(prev) : updater
  const next: MonitorState = { ...prev, ...patch }
  const completed = Object.values(next.runs)
    .filter((run) => run.status !== "running")
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  const expiredRuns = completed.slice(MAX_IN_MEMORY_COMPLETED_RUNS)
  if (expiredRuns.length > 0) {
    const expiredIds = new Set(expiredRuns.map((run) => run.id))
    const expiredNodeIds = new Set(
      Object.values(next.nodes).filter((node) => expiredIds.has(node.runId)).map((node) => node.id),
    )
    next.runs = Object.fromEntries(Object.entries(next.runs).filter(([id]) => !expiredIds.has(id)))
    next.nodes = Object.fromEntries(Object.entries(next.nodes).filter(([, node]) => !expiredIds.has(node.runId)))
    next.edges = Object.fromEntries(Object.entries(next.edges).filter(([, edge]) => !expiredIds.has(edge.runId)))
    next.nodeOrder = next.nodeOrder.filter((id) => !expiredNodeIds.has(id))
    if (next.selectedRunId && expiredIds.has(next.selectedRunId)) next.selectedRunId = undefined
    if (next.selectedNodeId && expiredNodeIds.has(next.selectedNodeId)) next.selectedNodeId = undefined
  }
  store.set(monitorAtom, next)
  persistMonitorHistory(next)
}


/** Hydrates the metadata-only server snapshot while preserving websocket updates that raced the request. */
export function hydrateMonitorHistory(snapshot: {
  runs?: unknown[]
  nodes?: unknown[]
  edges?: unknown[]
}) {
  const current = store.get(monitorAtom)
  const validTypes = new Set<MonitorNodeType>(["tool", "skill", "plugin", "file", "command", "pattern", "system"])
  const validStatuses = new Set<MonitorNodeStatus>(["pending", "running", "retrying", "completed", "failed"])
  const runs: MonitorState["runs"] = {}
  for (const raw of snapshot.runs ?? []) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !finiteNumber(raw.startedAt)) continue
    if (raw.status !== "running" && raw.status !== "completed" && raw.status !== "failed") continue
    runs[raw.id] = { id: raw.id, status: raw.status, startedAt: raw.startedAt,
      ...(finiteNumber(raw.endedAt) ? { endedAt: raw.endedAt } : {}),
      ...(finiteNumber(raw.planTotal) ? { planTotal: raw.planTotal } : {}),
      ...(finiteNumber(raw.planLevels) ? { planLevels: raw.planLevels } : {}),
    }
  }
  const nodes: MonitorState["nodes"] = {}
  for (const raw of snapshot.nodes ?? []) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.runId !== "string" || !runs[raw.runId]) continue
    if (typeof raw.label !== "string" || !validTypes.has(raw.type as MonitorNodeType) || !validStatuses.has(raw.status as MonitorNodeStatus)) continue
    if (!finiteNumber(raw.createdAt) || !finiteNumber(raw.updatedAt)) continue
    nodes[raw.id] = { id: raw.id, runId: raw.runId, type: raw.type as MonitorNodeType, label: raw.label,
      status: raw.status as MonitorNodeStatus, level: finiteNumber(raw.level) ? raw.level : 0, parallel: raw.parallel === true,
      ...(finiteNumber(raw.attempt) ? { attempt: raw.attempt } : {}), ...(finiteNumber(raw.durationMs) ? { durationMs: raw.durationMs } : {}),
      createdAt: raw.createdAt, updatedAt: raw.updatedAt, uiState: raw.uiState === "expanded" ? "expanded" : "minimized" }
  }
  const edges: MonitorState["edges"] = {}
  for (const raw of snapshot.edges ?? []) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.runId !== "string" || typeof raw.source !== "string" || typeof raw.target !== "string") continue
    if (!nodes[raw.source] || !nodes[raw.target] || !runs[raw.runId]) continue
    edges[raw.id] = { id: raw.id, runId: raw.runId, source: raw.source, target: raw.target, animated: false }
  }
  // Existing in-memory entries may be newer because the WebSocket stream is live while the snapshot loads.
  const mergedRuns = { ...runs, ...current.runs }
  const mergedNodes = { ...nodes, ...current.nodes }
  const mergedEdges = { ...edges, ...current.edges }
  const nodeOrder = [...new Set([...Object.keys(nodes), ...current.nodeOrder])].filter((id) => Boolean(mergedNodes[id]))
  const next = { ...current, runs: mergedRuns, nodes: mergedNodes, edges: mergedEdges, nodeOrder }
  store.set(monitorAtom, next)
  persistMonitorHistory(next)
}

export function resetMonitorStore() {
  const empty = emptyMonitorState()
  store.set(monitorAtom, empty)
  if (typeof window !== "undefined") {
    try { window.localStorage.removeItem(MONITOR_HISTORY_STORAGE_KEY) } catch { /* optional storage */ }
  }
}

export function clearMonitorRun(runId: string) {
  updateMonitorStore((prev) => {
    const nodeIds = new Set(
      Object.values(prev.nodes)
        .filter((node) => node.runId === runId)
        .map((node) => node.id),
    )
    if (nodeIds.size === 0 && !prev.runs[runId]) return {}

    const nodes = Object.fromEntries(
      Object.entries(prev.nodes).filter(([nodeId]) => !nodeIds.has(nodeId)),
    )
    const edges = Object.fromEntries(
      Object.entries(prev.edges).filter(([, edge]) => edge.runId !== runId),
    )
    const selectedNodeId = nodeIds.has(prev.selectedNodeId ?? "")
      ? undefined
      : prev.selectedNodeId
    const selectedRunId =
      prev.selectedRunId === runId ? undefined : prev.selectedRunId

    return {
      runs: Object.fromEntries(
        Object.entries(prev.runs).filter(([id]) => id !== runId),
      ),
      nodes,
      edges,
      nodeOrder: prev.nodeOrder.filter((nodeId) => !nodeIds.has(nodeId)),
      selectedNodeId,
      selectedRunId,
    }
  })
}

export function selectMonitorRun(runId?: string) {
  updateMonitorStore({
    selectedRunId: runId,
    selectedNodeId: undefined,
  })
}

export function selectMonitorNode(nodeId?: string) {
  updateMonitorStore((prev) => {
    const node = nodeId ? prev.nodes[nodeId] : undefined
    return {
      selectedNodeId: nodeId,
      selectedRunId: node?.runId ?? prev.selectedRunId,
    }
  })
}

export function toggleNodeUIState(nodeId: string) {
  updateMonitorStore((prev) => {
    const node = prev.nodes[nodeId]
    if (!node) return {}
    return {
      nodes: {
        ...prev.nodes,
        [nodeId]: {
          ...node,
          uiState: node.uiState === "expanded" ? "minimized" : "expanded",
        },
      },
    }
  })
}

export function setNodePosition(
  nodeId: string,
  position: { x: number; y: number },
) {
  updateMonitorStore((prev) => {
    const node = prev.nodes[nodeId]
    if (!node) return {}
    return {
      nodes: {
        ...prev.nodes,
        [nodeId]: { ...node, position, hasManualPosition: true },
      },
    }
  })
}
