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
  | "pending"
  | "running"
  | "retrying"
  | "completed"
  | "failed"

export type MonitorNodeType =
  | "tool"
  | "skill"
  | "plugin"
  | "pattern"
  | "system"

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
}

const initialState: MonitorState = {
  runs: {},
  nodes: {},
  edges: {},
  nodeOrder: [],
}

export const monitorAtom = atom<MonitorState>(initialState)

const store = getDefaultStore()

export function getMonitorState(): MonitorState {
  return store.get(monitorAtom)
}

export function updateMonitorStore(
  updater:
    | Partial<MonitorState>
    | ((prev: MonitorState) => Partial<MonitorState>),
) {
  const prev = store.get(monitorAtom)
  const patch = typeof updater === "function" ? updater(prev) : updater
  store.set(monitorAtom, { ...prev, ...patch })
}

export function resetMonitorStore() {
  store.set(monitorAtom, initialState)
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
