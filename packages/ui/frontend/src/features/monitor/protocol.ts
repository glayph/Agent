import type { mikiMessage } from "@/features/chat/protocol"
import {
  clearMonitorRun,
  getMonitorState,
  removeMonitorNode,
  updateMonitorStore,
  type MonitorEdge,
  type MonitorNode,
  type MonitorNodeStatus,
  type MonitorNodeType,
} from "@/features/monitor/store"

const NODE_EXIT_TRANSITION_MS = 800
const RUN_EXIT_TRANSITION_MS = 60_000
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
const terminalRunIds = new Set<string>()
const terminalRunOrder: string[] = []
const prunedNodeParents = new Map<string, { runId: string; parentIds: string[] }>()

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function numOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback
}

function inferNodeType(label: string): MonitorNodeType {
  // Compatibility fallback for older Gateway versions. Current events carry an explicit type.
  const lower = label.toLowerCase()
  if (lower.startsWith("agent:") || lower === "miki") return "agent"
  if (lower.startsWith("skill_") || lower.startsWith("skill:")) return "skill"
  if (lower.startsWith("plugin_") || lower.startsWith("plugin:")) return "plugin"
  if (lower.startsWith("browser_")) return "browser"
  if (lower.startsWith("computer_")) return "computer"
  if (lower.startsWith("terminal_") || lower.startsWith("shell_") || lower.startsWith("command_")) return "terminal"
  if (lower === "web_search") return "search"
  if (lower.startsWith("memory_")) return "memory"
  if (lower.startsWith("file_") || lower.startsWith("workspace_")) return "file"
  if (lower.includes("__")) return "mcp"
  if (lower.startsWith("plan_step_")) return "workflow"
  return "tool"
}

function safeParentIds(runId: string, nodeId: string, input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return [...new Set(input
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 200 && value !== nodeId && value.startsWith(`${runId}:`))
    .slice(0, 50))]
}

function rememberTerminalRun(runId: string) {
  if (terminalRunIds.has(runId)) return
  terminalRunIds.add(runId)
  terminalRunOrder.push(runId)
  while (terminalRunOrder.length > 500) {
    const expired = terminalRunOrder.shift()
    if (expired) terminalRunIds.delete(expired)
  }
}

function clearRunTimers(runId: string) {
  const prefix = `${runId}\u0000`
  for (const [key, timer] of cleanupTimers) {
    if (!key.startsWith(prefix)) continue
    clearTimeout(timer)
    cleanupTimers.delete(key)
  }
}

function clearNodeCleanup(runId: string, nodeId: string) {
  const key = `${runId}\u0000${nodeId}`
  const timer = cleanupTimers.get(key)
  if (!timer) return
  clearTimeout(timer)
  cleanupTimers.delete(key)
}

function resolveVisibleParents(runId: string, parentIds: string[], nodes: Record<string, MonitorNode>, visiting = new Set<string>()): string[] {
  const resolved = new Set<string>()
  for (const parentId of parentIds) {
    if (visiting.has(parentId)) continue
    const parent = nodes[parentId]
    if (parent && parent.runId === runId) {
      resolved.add(parentId)
      continue
    }
    const pruned = prunedNodeParents.get(parentId)
    if (pruned?.runId === runId) {
      const next = new Set(visiting).add(parentId)
      for (const ancestor of resolveVisibleParents(runId, pruned.parentIds, nodes, next)) resolved.add(ancestor)
    }
  }
  // A parent reference can be valid for this run but never materialize (for
  // example, an old planner step ID or a tool event emitted after its plan was
  // replaced). Do not leave the child floating: anchor it to the run root until
  // the real parent arrives. rebuildRunEdges() runs on every spawn, so this
  // temporary root edge is automatically replaced by the semantic edge later.
  if (resolved.size === 0) {
    const rootId = `${runId}:root`
    if (nodes[rootId] && !parentIds.includes(rootId)) resolved.add(rootId)
  }
  return [...resolved]
}

function rebuildRunEdges(runId: string, nodes: Record<string, MonitorNode>): Record<string, MonitorEdge> {
  const state = getMonitorState()
  const edges = Object.fromEntries(Object.entries(state.edges).filter(([, edge]) => edge.runId !== runId)) as Record<string, MonitorEdge>
  for (const node of Object.values(nodes)) {
    if (node.runId !== runId || node.id === `${runId}:root`) continue
    const originalParents = node.parentNodeIds?.length ? node.parentNodeIds : [`${runId}:root`]
    const visibleParents = resolveVisibleParents(runId, originalParents, nodes)
    for (const source of visibleParents) {
      if (source === node.id) continue
      const contracted = !originalParents.includes(source)
      const id = `${source}->${node.id}`
      edges[id] = { id, source, target: node.id, runId, animated: node.status === "running" || node.status === "retrying", ...(contracted ? { displayOnly: true } : {}) }
    }
  }
  return edges
}

function scheduleNodeCleanup(runId: string, nodeId: string) {
  const key = `${runId}\u0000${nodeId}`
  const existing = cleanupTimers.get(key)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    cleanupTimers.delete(key)
    if (terminalRunIds.has(runId)) return
    const state = getMonitorState()
    const node = state.nodes[nodeId]
    if (!node || node.runId !== runId) return
    // A retry/recovery may re-emit the same logical node before this timer
    // fires. Never remove a node that has become active again.
    if (node.status !== "completed" && node.status !== "failed") return
    prunedNodeParents.set(nodeId, { runId, parentIds: node.parentNodeIds?.length ? [...node.parentNodeIds] : [`${runId}:root`] })
    removeMonitorNode(nodeId)
    updateMonitorStore((prev) => ({ edges: rebuildRunEdges(runId, prev.nodes) }))
  }, NODE_EXIT_TRANSITION_MS)
  cleanupTimers.set(key, timer)
}

function scheduleRunCleanup(runId: string) {
  clearRunTimers(runId)
  const key = `${runId}\u0000__run__`
  const timer = setTimeout(() => {
    cleanupTimers.delete(key)
    clearMonitorRun(runId)
    for (const [nodeId, pruned] of prunedNodeParents) if (pruned.runId === runId) prunedNodeParents.delete(nodeId)
  }, RUN_EXIT_TRANSITION_MS)
  cleanupTimers.set(key, timer)
}

/** Test/runtime teardown hook: cancels visual cleanup timers without changing persisted history. */
export function resetMonitorProtocolLifecycle() {
  for (const timer of cleanupTimers.values()) clearTimeout(timer)
  cleanupTimers.clear()
  terminalRunIds.clear()
  terminalRunOrder.length = 0
  prunedNodeParents.clear()
}

export function handleMonitorMessage(message: mikiMessage) {
  const payload = message.payload || {}
  const timestamp = Date.now()

  switch (message.type) {
    case "node.run_start": {
      const runId = str(payload.run_id)
      if (!runId) break
      terminalRunIds.delete(runId)
      for (const [nodeId, pruned] of prunedNodeParents) if (pruned.runId === runId) prunedNodeParents.delete(nodeId)
      const terminalIndex = terminalRunOrder.indexOf(runId)
      if (terminalIndex >= 0) terminalRunOrder.splice(terminalIndex, 1)
      clearRunTimers(runId)
      updateMonitorStore((prev) => ({
        runs: {
          ...prev.runs,
          [runId]: {
            id: runId,
            objective: str(payload.objective) || undefined,
            status: "running",
            startedAt: timestamp,
          },
        },
      }))
      break
    }

    case "node.plan": {
      const runId = str(payload.run_id)
      if (!runId || terminalRunIds.has(runId)) break
      updateMonitorStore((prev) => {
        const run = prev.runs[runId]
        if (!run) return {}
        return {
          runs: {
            ...prev.runs,
            [runId]: {
              ...run,
              planTotal: numOrUndefined(payload.total),
              planLevels: numOrUndefined(payload.levels),
              accelerationMode: str(payload.acceleration_mode) || undefined,
              speedClass: str(payload.speed_class) || undefined,
            },
          },
        }
      })
      break
    }

    case "node.spawn": {
      const runId = str(payload.run_id)
      const nodeId = str(payload.node_id)
      if (!runId || !nodeId || terminalRunIds.has(runId)) break

      const label = str(payload.label, "unknown")
      const level = num(payload.level, 0)
      const requestedStatus = str(payload.status)
      const validStatuses: MonitorNodeStatus[] = ["pending", "running", "retrying", "completed", "failed"]
      const status: MonitorNodeStatus = validStatuses.includes(requestedStatus as MonitorNodeStatus)
        ? requestedStatus as MonitorNodeStatus
        : "running"
      const explicitParents = safeParentIds(runId, nodeId, payload.parent_node_ids ?? payload.depends_on)
      const parentNodeIds = nodeId === `${runId}:root`
        ? []
        : explicitParents.length > 0 ? explicitParents : [`${runId}:root`]

      clearNodeCleanup(runId, nodeId)
      updateMonitorStore((prev) => {
        const previous = prev.nodes[nodeId]
        const typeValue = str(payload.node_type)
        const validTypes: MonitorNodeType[] = ["tool", "skill", "plugin", "file", "command", "pattern", "system", "browser", "computer", "terminal", "memory", "mcp", "search", "goal", "workflow", "agent"]
        const type = validTypes.includes(typeValue as MonitorNodeType)
          ? typeValue as MonitorNodeType
          : inferNodeType(label)
        const node: MonitorNode = {
          ...(previous ?? {} as MonitorNode),
          id: nodeId,
          runId,
          type,
          label,
          ...(typeof payload.icon_key === "string" ? { iconKey: payload.icon_key } : previous?.iconKey ? { iconKey: previous.iconKey } : {}),
          ...(typeof payload.display_name === "string" ? { displayName: payload.display_name } : previous?.displayName ? { displayName: previous.displayName } : {}),
          ...(typeof payload.tool_name === "string" ? { toolName: payload.tool_name } : previous?.toolName ? { toolName: previous.toolName } : {}),
          ...(typeof payload.plugin_id === "string" ? { pluginId: payload.plugin_id } : previous?.pluginId ? { pluginId: previous.pluginId } : {}),
          ...(typeof payload.provider_id === "string" ? { providerId: payload.provider_id } : previous?.providerId ? { providerId: previous.providerId } : {}),
          parentNodeIds,
          status,
          level,
          parallel: bool(payload.parallel, false),
          input: payload.input,
          action: str(payload.action) || previous?.action,
          createdAt: previous?.createdAt ?? timestamp,
          updatedAt: timestamp,
          uiState: previous?.uiState ?? "minimized",
        }
        const nextNodes = { ...prev.nodes, [nodeId]: node }
        // Rebuild from explicit semantic parents. Missing parent nodes remain as IDs
        // on their child; if they arrive later, this pass resolves the edge then.
        const nextEdges = rebuildRunEdges(runId, nextNodes)
        return {
          nodes: nextNodes,
          nodeOrder: prev.nodeOrder.includes(nodeId) ? prev.nodeOrder : [...prev.nodeOrder, nodeId],
          edges: nextEdges,
        }
      })
      if (status === "completed" || status === "failed") scheduleNodeCleanup(runId, nodeId)
      break
    }

    case "node.update": {
      const runId = str(payload.run_id)
      const nodeId = str(payload.node_id)
      if (!nodeId || (runId && terminalRunIds.has(runId))) break
      const status = str(payload.status) as MonitorNodeStatus
      if (status === "pending" || status === "running" || status === "retrying") {
        const existing = getMonitorState().nodes[nodeId]
        if (existing) clearNodeCleanup(existing.runId, nodeId)
      }
      updateMonitorStore((prev) => {
        const node = prev.nodes[nodeId]
        if (!node || (runId && node.runId !== runId)) return {}
        const nextStatus = status || node.status
        const nextEdges = { ...prev.edges }
        for (const [edgeId, edge] of Object.entries(nextEdges)) {
          if (edge.target === nodeId) {
            nextEdges[edgeId] = { ...edge, animated: nextStatus === "running" || nextStatus === "retrying" }
          }
        }
        return {
          nodes: {
            ...prev.nodes,
            [nodeId]: {
              ...node,
              status: nextStatus,
              attempt: num(payload.attempt, node.attempt ?? 0) || node.attempt,
              updatedAt: timestamp,
            },
          },
          edges: nextEdges,
        }
      })
      if (status === "completed" || status === "failed") {
        const node = getMonitorState().nodes[nodeId]
        if (node) scheduleNodeCleanup(node.runId, nodeId)
      }
      break
    }

    case "node.complete": {
      const runId = str(payload.run_id)
      const nodeId = str(payload.node_id)
      if (!nodeId || (runId && terminalRunIds.has(runId))) break
      const ok = bool(payload.ok, true)

      updateMonitorStore((prev) => {
        const node = prev.nodes[nodeId]
        if (!node || (runId && node.runId !== runId)) return {}
        const nextEdges = { ...prev.edges }
        for (const [edgeId, edge] of Object.entries(nextEdges)) {
          if (edge.target === nodeId || (!ok && edge.source === nodeId)) {
            nextEdges[edgeId] = { ...edge, animated: false }
          }
        }
        return {
          nodes: {
            ...prev.nodes,
            [nodeId]: {
              ...node,
              status: ok ? "completed" : "failed",
              durationMs: numOrUndefined(payload.duration_ms),
              action: str(payload.action) || node.action,
              resultMessage: str(payload.result_message) || node.resultMessage,
              outputPreview: str(payload.output_preview) || undefined,
              error: !ok
                ? str(payload.error) || str(payload.result_message) || str(payload.output_preview) || "Tool failed"
                : undefined,
              updatedAt: timestamp,
            },
          },
          edges: nextEdges,
        }
      })
      const node = getMonitorState().nodes[nodeId]
      if (node) scheduleNodeCleanup(node.runId, nodeId)
      break
    }

    case "node.metrics":
      break

    case "node.run_end": {
      const runId = str(payload.run_id)
      if (!runId) break
      const rawStatus = str(payload.status)
      const status: "completed" | "failed" =
        rawStatus === "failed" || rawStatus === "cancelled" ? "failed" : "completed"
      rememberTerminalRun(runId)
      updateMonitorStore((prev) => {
        const run = prev.runs[runId]
        if (!run) return {}
        const nextNodes = { ...prev.nodes }
        const rootId = `${runId}:root`
        const root = nextNodes[rootId]
        if (root) nextNodes[rootId] = { ...root, status, updatedAt: timestamp }
        const nextEdges = { ...prev.edges }
        for (const [edgeId, edge] of Object.entries(nextEdges)) {
          if (edge.runId === runId) nextEdges[edgeId] = { ...edge, animated: false }
        }
        return {
          runs: {
            ...prev.runs,
            [runId]: {
              ...run,
              status,
              endedAt: timestamp,
            },
          },
          nodes: nextNodes,
          edges: nextEdges,
        }
      })
      scheduleRunCleanup(runId)
      break
    }

    default:
      break
  }
}
