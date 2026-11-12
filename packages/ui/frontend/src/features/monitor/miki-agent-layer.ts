import type { MonitorEdge, MonitorNode } from "@/features/monitor/store"

export const MIKI_AGENT_NODE_ID = "miki-agent"

const MIKI_AGENT_RUN_ID = "miki-agent-runtime"
const LIVE_TOOL_STATUSES = new Set<MonitorNode["status"]>(["pending", "running", "retrying"])

/** Project only the live execution surface; history stays on Activity. */
export function withMikiAgentLayer(
  nodes: MonitorNode[],
  edges: MonitorEdge[],
  now = Date.now(),
): { nodes: MonitorNode[]; edges: MonitorEdge[] } {
  const liveNodes = nodes.filter((node) => LIVE_TOOL_STATUSES.has(node.status))
  const activeTools = liveNodes.filter((node) => Boolean(node.toolName?.trim()))
  // Do not leave a synthetic agent card or edges on an idle canvas. Completed
  // and failed records are historical data, not live execution.
  if (liveNodes.length === 0) return { nodes: [], edges: [] }
  const activeCount = activeTools.length
  const agent: MonitorNode = {
    id: MIKI_AGENT_NODE_ID,
    runId: MIKI_AGENT_RUN_ID,
    type: "agent",
    label: "Miki",
    iconKey: "agent",
    displayName: "Miki",
    status: "running",
    level: 0,
    parallel: false,
    createdAt: now,
    updatedAt: now,
    // Keep the persistent agent marker compact so it does not dominate the
    // execution flow; detailed activity remains available on tool nodes.
    uiState: "minimized",
    action: activeCount > 0
      ? `Calling ${activeCount} tool${activeCount === 1 ? "" : "s"}`
      : "Standing by for tool calls",
  }
  // Treat Miki as the flow entry point. Prefer each run's explicit goal/root so
  // the graph reads Miki -> goal -> plan/tool nodes instead of leaving the
  // agent card floating beside an otherwise connected run. Older Gateway
  // snapshots may not contain a root, so anchor every orphan entry component
  // to Miki without inventing dependencies between sibling nodes.
  const roots = liveNodes.filter((node) => node.id === `${node.runId}:root`)
  const rootIds = new Set(roots.map((node) => node.id))
  const liveNodeIds = new Set(liveNodes.map((node) => node.id))
  const activeEdges = edges.filter((edge) => liveNodeIds.has(edge.source) && liveNodeIds.has(edge.target))
  const incoming = new Set(activeEdges.map((edge) => edge.target))
  const orphanEntries = liveNodes.filter((node) => !incoming.has(node.id) && !rootIds.has(node.id))
  const fallbackTargets = activeTools.filter((tool) => !incoming.has(tool.id))
  const targets = roots.length > 0
    ? roots
    : orphanEntries.length > 0
      ? orphanEntries
      : fallbackTargets
  const liveEdges: MonitorEdge[] = targets.map((target) => ({
    id: `${MIKI_AGENT_NODE_ID}->${target.id}`,
    source: MIKI_AGENT_NODE_ID,
    target: target.id,
    runId: target.runId,
    animated: target.status === "running" || target.status === "retrying",
    displayOnly: true,
  }))

  return { nodes: [...liveNodes, agent], edges: [...activeEdges, ...liveEdges] }
}
