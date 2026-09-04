import type { mikiMessage } from "@/features/chat/protocol"
import {
  type MonitorEdge,
  type MonitorNode,
  type MonitorNodeStatus,
  type MonitorNodeType,
  getMonitorState,
  updateMonitorStore,
} from "@/features/monitor/store"

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

/**
 * Infers a node's monitoring category from its tool name. The backend only
 * knows about "tools" today (see api/index.ts node.spawn payloads), but
 * skills/plugins/files/commands route through the same tool-call mechanism
 * with recognizable name prefixes, so the graph can differentiate them
 * without requiring a second websocket transport.
 */
function inferNodeType(label: string): MonitorNodeType {
  const lower = label.toLowerCase()
  if (lower.startsWith("skill:") || lower.includes("skill_")) return "skill"
  if (lower.startsWith("plugin:") || lower.includes("plugin_")) return "plugin"
  if (
    lower.startsWith("file:") ||
    lower.includes("file_") ||
    /(^|[._-])(read|write|create|edit|move|copy|delete)[._-]?file/.test(lower)
  ) {
    return "file"
  }
  if (
    lower.startsWith("command:") ||
    lower.startsWith("shell:") ||
    lower.startsWith("exec:") ||
    lower.includes("terminal") ||
    lower.includes("shell_") ||
    lower.includes("command_") ||
    lower.includes("execute_")
  ) {
    return "command"
  }
  if (
    lower.startsWith("pattern:") ||
    lower.includes("workflow") ||
    lower.includes("orchestrat")
  )
    return "pattern"
  if (lower.startsWith("system:") || lower.includes("system_")) return "system"
  return "tool"
}

function buildEdgesForLevel(
  runId: string,
  level: number,
  newNodeId: string,
): MonitorEdge[] {
  const state = getMonitorState()
  if (level === 0) return []

  // Connect this node to every node in the immediately preceding level of
  // the same run. This mirrors the planner's actual dependency structure:
  // everything in level N only becomes runnable once level N-1 completes.
  const previousLevelNodeIds = Object.values(state.nodes)
    .filter((node) => node.runId === runId && node.level === level - 1)
    .map((node) => node.id)

  return previousLevelNodeIds.map((sourceId) => ({
    id: `${sourceId}->${newNodeId}`,
    source: sourceId,
    target: newNodeId,
    runId,
    animated: true,
  }))
}

export function handleMonitorMessage(message: mikiMessage) {
  const payload = message.payload || {}
  const timestamp = Date.now()

  switch (message.type) {
    case "node.run_start": {
      const runId = str(payload.run_id)
      if (!runId) break
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
      if (!runId) break
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
      if (!runId || !nodeId) break

      const label = str(payload.label, "unknown")
      const level = num(payload.level, 0)
      const edges = buildEdgesForLevel(runId, level, nodeId)

      updateMonitorStore((prev) => {
        const node: MonitorNode = {
          id: nodeId,
          runId,
          type: inferNodeType(label),
          label,
          status: "running",
          level,
          parallel: bool(payload.parallel, false),
          input: payload.input,
          action: str(payload.action) || undefined,
          createdAt: timestamp,
          updatedAt: timestamp,
          uiState: "minimized",
        }

        const nextEdges = { ...prev.edges }
        for (const edge of edges) {
          nextEdges[edge.id] = edge
        }

        return {
          nodes: { ...prev.nodes, [nodeId]: node },
          nodeOrder: prev.nodeOrder.includes(nodeId)
            ? prev.nodeOrder
            : [...prev.nodeOrder, nodeId],
          edges: nextEdges,
        }
      })
      break
    }

    case "node.update": {
      const nodeId = str(payload.node_id)
      if (!nodeId) break
      const status = str(payload.status) as MonitorNodeStatus

      updateMonitorStore((prev) => {
        const node = prev.nodes[nodeId]
        if (!node) return {}
        return {
          nodes: {
            ...prev.nodes,
            [nodeId]: {
              ...node,
              status: status || node.status,
              attempt: num(payload.attempt, node.attempt ?? 0) || node.attempt,
              updatedAt: timestamp,
            },
          },
        }
      })
      break
    }

    case "node.complete": {
      const nodeId = str(payload.node_id)
      if (!nodeId) break
      const ok = bool(payload.ok, true)

      updateMonitorStore((prev) => {
        const node = prev.nodes[nodeId]
        if (!node) return {}

        // Stop the flow into this activity once it settles. If the activity
        // failed, also stop any downstream flow that may already exist. A
        // successful predecessor may keep an outgoing edge animated while a
        // dependent activity is still running.
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
                ? str(payload.result_message) ||
                  str(payload.output_preview) ||
                  "Tool failed"
                : undefined,
              updatedAt: timestamp,
            },
          },
          edges: nextEdges,
        }
      })
      break
    }

    case "node.metrics": {
      // Reserved for a future metrics HUD; intentionally not stored on
      // individual nodes today to avoid re-rendering the whole graph on
      // every concurrency snapshot.
      break
    }

    case "node.run_end": {
      const runId = str(payload.run_id)
      if (!runId) break
      const status = str(payload.status) as "completed" | "failed"

      updateMonitorStore((prev) => {
        const run = prev.runs[runId]
        if (!run) return {}
        return {
          runs: {
            ...prev.runs,
            [runId]: {
              ...run,
              status: status || "completed",
              endedAt: timestamp,
            },
          },
        }
      })

      // Keep terminal runs in session monitor history so the Inspector's
      // Work, Evidence, and Events tabs remain useful after streaming stops.
      // Session reset owns cleanup instead of a short timer.
      break
    }

    default:
      break
  }
}
