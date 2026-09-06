import type { Edge, Node } from "@xyflow/react"
import dagre from "dagre"

import type { MonitorEdge, MonitorNode } from "@/features/monitor/store"

const MINIMIZED_SIZE = 64
const EXPANDED_WIDTH = 280
const EXPANDED_HEIGHT = 180

/**
 * Runs dagre over the current graph to produce positions for nodes that
 * haven't been explicitly placed (by the user dragging them, or by the
 * agent issuing an explicit `node.layout` instruction in the future).
 * Manually placed nodes keep their existing position so the agent — or a
 * person — can rearrange the canvas without the engine fighting them on
 * every update.
 */
export function computeLayout(
  nodes: MonitorNode[],
  edges: MonitorEdge[],
): { nodes: MonitorNode[]; edges: MonitorEdge[] } {
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({
    rankdir: "LR",
    nodesep: 48,
    ranksep: 120,
    marginx: 40,
    marginy: 40,
  })

  for (const node of nodes) {
    const size =
      node.uiState === "expanded"
        ? { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT }
        : { width: MINIMIZED_SIZE, height: MINIMIZED_SIZE }
    graph.setNode(node.id, size)
  }

  for (const edge of edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      graph.setEdge(edge.source, edge.target)
    }
  }

  dagre.layout(graph)

  const positioned = nodes.map((node) => {
    if (node.hasManualPosition && node.position) {
      return node
    }
    const dagreNode = graph.node(node.id)
    if (!dagreNode) return node
    const size =
      node.uiState === "expanded"
        ? { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT }
        : { width: MINIMIZED_SIZE, height: MINIMIZED_SIZE }
    return {
      ...node,
      position: {
        x: dagreNode.x - size.width / 2,
        y: dagreNode.y - size.height / 2,
      },
    }
  })

  return { nodes: positioned, edges }
}

export function toReactFlowNodes(nodes: MonitorNode[]): Node[] {
  return nodes.map((node) => ({
    id: node.id,
    type: "agentNode",
    position: node.position ?? { x: 0, y: 0 },
    data: { node },
    draggable: true,
  }))
}

export function toReactFlowEdges(edges: MonitorEdge[]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "flowEdge",
    animated: edge.animated,
    data: { animated: edge.animated },
  }))
}
