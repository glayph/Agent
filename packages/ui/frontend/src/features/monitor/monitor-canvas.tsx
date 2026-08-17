import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeTypes,
  type EdgeTypes,
  type NodeMouseHandler,
  type OnNodeDrag,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import "@/features/monitor/monitor.css"
import { useAtomValue } from "jotai"
import { useEffect, useMemo, useRef } from "react"

import { AgentNode } from "@/features/monitor/agent-node"
import { FlowEdge } from "@/features/monitor/flow-edge"
import { computeLayout, toReactFlowEdges, toReactFlowNodes } from "@/features/monitor/layout"
import { monitorAtom, setNodePosition, toggleNodeUIState } from "@/features/monitor/store"

const nodeTypes: NodeTypes = { agentNode: AgentNode }
const edgeTypes: EdgeTypes = { flowEdge: FlowEdge }

function CanvasInner() {
  const state = useAtomValue(monitorAtom)
  const { fitView } = useReactFlow()
  const hasFitOnce = useRef(false)
  const previousNodeCount = useRef(0)

  const { nodes, edges } = useMemo(() => {
    const rawNodes = Object.values(state.nodes)
    const rawEdges = Object.values(state.edges)
    const { nodes: positioned } = computeLayout(rawNodes, rawEdges)
    return {
      nodes: toReactFlowNodes(positioned),
      edges: toReactFlowEdges(rawEdges),
    }
  }, [state.nodes, state.edges])

  useEffect(() => {
    // Auto-fit the view whenever new nodes spawn, so the agent's own
    // layout decisions stay visible without the person needing to pan.
    if (nodes.length === 0) return
    const grew = nodes.length > previousNodeCount.current
    previousNodeCount.current = nodes.length
    if (!hasFitOnce.current || grew) {
      hasFitOnce.current = true
      const id = window.setTimeout(() => {
        fitView({ padding: 0.35, duration: 400, maxZoom: 1.1 })
      }, 50)
      return () => window.clearTimeout(id)
    }
  }, [nodes.length, fitView])

  const handleNodeDoubleClick: NodeMouseHandler = (event, node) => {
    event.stopPropagation()
    toggleNodeUIState(node.id)
  }

  const handleNodeDragStop: OnNodeDrag = (_event, node) => {
    setNodePosition(node.id, node.position)
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeDoubleClick={handleNodeDoubleClick}
      onNodeDragStop={handleNodeDragStop}
      proOptions={{ hideAttribution: true }}
      minZoom={0.15}
      maxZoom={2}
      defaultEdgeOptions={{ type: "flowEdge" }}
      panOnScroll
      selectionOnDrag={false}
      className="agent-monitor-flow"
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={28}
        size={1}
        color="rgba(255,255,255,0.06)"
      />
    </ReactFlow>
  )
}

/**
 * The Smart Work Monitoring canvas.
 *
 * Per spec: a completely blank grid with zero static UI chrome. Nodes are
 * never hardcoded — every node and edge rendered here comes exclusively
 * from live `node.*` websocket events accumulated in the monitor store
 * (features/monitor/protocol.ts + store.ts). When nothing is executing,
 * this renders an empty dotted grid and nothing else.
 */
export function MonitorCanvas() {
  return (
    <div className="h-full w-full bg-[#0b0c0f]">
      <ReactFlowProvider>
        <CanvasInner />
      </ReactFlowProvider>
    </div>
  )
}
