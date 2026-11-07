import { Position, type Edge, type Node } from "@xyflow/react"
import dagre from "dagre"

import type { MonitorEdge, MonitorNode } from "@/features/monitor/store"
import { MONITOR_NODE_DIMENSIONS } from "@/features/monitor/node-visuals.constants"

const NODE_COLLISION_GAP = 32

type LayoutRect = {
  x: number
  y: number
  width: number
  height: number
}

function overlaps(left: LayoutRect, right: LayoutRect): boolean {
  return left.x < right.x + right.width + NODE_COLLISION_GAP
    && left.x + left.width + NODE_COLLISION_GAP > right.x
    && left.y < right.y + right.height + NODE_COLLISION_GAP
    && left.y + left.height + NODE_COLLISION_GAP > right.y
}

/**
 * Dagre does not know about nodes whose positions are owned by the user.
 * When a manually placed node is present, a newly spawned auto node can
 * therefore be assigned the same rectangle. Keep Dagre's rank (x) but move
 * colliding auto nodes into the next free vertical lane. This also protects
 * against disconnected components that Dagre places at the same origin.
 */
function resolveCollisions(
  nodes: MonitorNode[],
  candidates: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
  const placed: LayoutRect[] = []
  const result = new Map<string, { x: number; y: number }>()

  for (const node of nodes) {
    const size = MONITOR_NODE_DIMENSIONS[node.uiState]
    const position = node.hasManualPosition && node.position
      ? node.position
      : candidates.get(node.id)
    if (!position) continue

    const rect: LayoutRect = { ...position, ...size }
    if (!node.hasManualPosition) {
      let guard = 0
      while (placed.some((other) => overlaps(rect, other)) && guard < nodes.length * 4 + 8) {
        const blockers = placed.filter((other) => overlaps(rect, other))
        const nextY = Math.max(...blockers.map((blocker) => blocker.y + blocker.height + NODE_COLLISION_GAP))
        rect.y = nextY
        guard += 1
      }
    }

    placed.push(rect)
    result.set(node.id, { x: rect.x, y: rect.y })
  }
  return result
}

function enforceFlowDirection(
  nodes: MonitorNode[],
  edges: MonitorEdge[],
  positions: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
  const next = new Map<string, { x: number; y: number }>()
  for (const [id, position] of positions) next.set(id, { x: position.x, y: position.y })
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const gap = 120

  // Keep dependency flow left-to-right even when Dagre receives a graph with
  // disconnected historical runs, stale edges, or an ordering cycle. This is
  // the last geometry guard before React Flow renders the handles.
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false
    for (const edge of edges) {
      const source = next.get(edge.source)
      const target = next.get(edge.target)
      const sourceNode = byId.get(edge.source)
      const targetNode = byId.get(edge.target)
      if (!source || !target || !sourceNode || !targetNode) continue
      const requiredTargetX = source.x + MONITOR_NODE_DIMENSIONS[sourceNode.uiState].width + gap
      if (target.x >= requiredTargetX) continue
      if (!targetNode.hasManualPosition) {
        target.x = requiredTargetX
        changed = true
      } else if (!sourceNode.hasManualPosition) {
        source.x = target.x - MONITOR_NODE_DIMENSIONS[sourceNode.uiState].width - gap
        changed = true
      }
    }
    if (!changed) break
  }
  return next
}

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
    const size = MONITOR_NODE_DIMENSIONS[node.uiState]
    // Dagre mutates node metadata by adding x/y during layout. Never pass the
    // shared MONITOR_NODE_DIMENSIONS object, otherwise the last laid-out node
    // overwrites every other node's geometry and edges miss their handles.
    graph.setNode(node.id, { width: size.width, height: size.height })
  }

  for (const edge of edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      graph.setEdge(edge.source, edge.target)
    }
  }

  dagre.layout(graph)

  const candidates = new Map<string, { x: number; y: number }>()
  for (const node of nodes) {
    if (node.hasManualPosition && node.position) continue
    const dagreNode = graph.node(node.id)
    if (!dagreNode) continue
    const size = MONITOR_NODE_DIMENSIONS[node.uiState]
    candidates.set(node.id, {
      x: dagreNode.x - size.width / 2,
      y: dagreNode.y - size.height / 2,
    })
  }

  const positions = resolveCollisions(nodes, candidates)
  const directionalPositions = enforceFlowDirection(nodes, edges, positions)
  const collisionFreePositions = resolveCollisions(nodes, directionalPositions)
  const positioned = nodes.map((node) => {
    if (node.hasManualPosition && node.position) return node
    const position = collisionFreePositions.get(node.id)
    return position ? { ...node, position } : node
  })

  return { nodes: positioned, edges }
}

export function toReactFlowNodes(nodes: MonitorNode[]): Node[] {
  return nodes.map((node) => ({
    id: node.id,
    type: "agentNode",
    position: node.position ?? { x: 0, y: 0 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: { node },
    draggable: true,
  }))
}

export function toReactFlowEdges(edges: MonitorEdge[]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: "source",
    targetHandle: "target",
    type: "flowEdge",
    animated: edge.animated,
    data: { animated: edge.animated },
  }))
}
