import {
  IconActivity,
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconExternalLink,
  IconInfoCircle,
  IconLoader2,
  IconRefresh,
  IconX,
} from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"
import {
  Background,
  BackgroundVariant,
  Controls,
  type EdgeMouseHandler,
  type EdgeTypes,
  type NodeMouseHandler,
  type NodeTypes,
  type OnNodeDrag,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { useAtomValue } from "jotai"
import { useEffect, useMemo, useRef } from "react"

import {
  activityStatusLabel,
  activitySummary,
  activityTitle,
  activityTypeLabel,
  formatActivityDuration,
  formatActivityTime,
} from "@/features/monitor/activity-copy"
import { AgentNode } from "@/features/monitor/agent-node"
import { FlowEdge } from "@/features/monitor/flow-edge"
import {
  computeLayout,
  toReactFlowEdges,
  toReactFlowNodes,
} from "@/features/monitor/layout"
import "@/features/monitor/monitor.css"
import {
  type MonitorNode,
  type MonitorRun,
  monitorAtom,
  selectMonitorNode,
  setNodePosition,
  toggleNodeUIState,
} from "@/features/monitor/store"
import { cn } from "@/lib/utils"

const nodeTypes: NodeTypes = { agentNode: AgentNode }
const edgeTypes: EdgeTypes = { flowEdge: FlowEdge }

function stringifyInspectorValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function StatusGlyph({ node }: { node: MonitorNode }) {
  if (node.status === "running" || node.status === "retrying") {
    return <IconLoader2 className="text-primary size-4 animate-spin" />
  }
  if (node.status === "failed") {
    return <IconAlertTriangle className="text-destructive size-4" />
  }
  return <IconCheck className="text-success size-4" />
}

function CanvasInner({ selectedNodeId }: { selectedNodeId?: string }) {
  const state = useAtomValue(monitorAtom)
  const { fitView } = useReactFlow()
  const hasFitOnce = useRef(false)
  const previousNodeCount = useRef(0)

  const { nodes, edges } = useMemo(() => {
    const rawNodes = Object.values(state.nodes)
    const rawEdges = Object.values(state.edges)
    const { nodes: positioned } = computeLayout(rawNodes, rawEdges)
    return {
      nodes: toReactFlowNodes(positioned).map((node) => ({
        ...node,
        selected: node.id === selectedNodeId,
      })),
      edges: toReactFlowEdges(rawEdges),
    }
  }, [selectedNodeId, state.edges, state.nodes])

  useEffect(() => {
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
  }, [fitView, nodes.length])

  const handleNodeDoubleClick: NodeMouseHandler = (event, node) => {
    event.stopPropagation()
    toggleNodeUIState(node.id)
  }

  const handleNodeClick: NodeMouseHandler = (event, node) => {
    event.stopPropagation()
    selectMonitorNode(node.id)
  }

  const handleNodeDragStop: OnNodeDrag = (_event, node) => {
    setNodePosition(node.id, node.position)
  }

  const handleEdgeClick: EdgeMouseHandler = (event, edge) => {
    event.stopPropagation()
    const targetNode = state.nodes[edge.target] ?? state.nodes[edge.source]
    if (targetNode) selectMonitorNode(targetNode.id)
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={handleNodeClick}
      onNodeDoubleClick={handleNodeDoubleClick}
      onEdgeClick={handleEdgeClick}
      onPaneClick={() => selectMonitorNode(undefined)}
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
        color="var(--md-sys-color-outline-variant)"
      />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  )
}

function ActivityInspector({
  node,
  run,
}: {
  node: MonitorNode
  run?: MonitorRun
}) {
  const input = stringifyInspectorValue(node.input)
  const action = stringifyInspectorValue(node.action)
  const result = stringifyInspectorValue(node.resultMessage)
  const output = stringifyInspectorValue(node.outputPreview)

  return (
    <aside
      aria-label="Live activity inspector"
      className="border-primary/25 bg-card/95 text-card-foreground shadow-primary/10 pointer-events-auto absolute top-4 right-4 z-20 flex max-h-[calc(100%-2rem)] w-[min(390px,calc(100%-2rem))] flex-col overflow-hidden rounded-2xl border shadow-2xl backdrop-blur-xl"
    >
      <div className="border-border/70 bg-primary/[0.06] flex items-start gap-3 border-b px-4 py-3.5">
        <div className="border-primary/25 bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-xl border">
          <IconActivity className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-primary flex items-center gap-2 text-[10px] font-semibold tracking-[0.16em] uppercase">
            <span>Live inspector</span>
            <span className="bg-primary size-1 rounded-full" />
            <span>{activityTypeLabel(node.type)}</span>
          </div>
          <h2
            className="mt-1 truncate text-[15px] font-semibold"
            title={activityTitle(node)}
          >
            {activityTitle(node)}
          </h2>
          <p className="text-muted-foreground mt-1 text-[11px] leading-4">
            {activitySummary(node)}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close activity inspector"
          onClick={() => selectMonitorNode(undefined)}
          className="border-border/70 text-muted-foreground hover:border-primary/35 hover:bg-primary/10 hover:text-foreground focus-visible:ring-ring inline-flex size-8 shrink-0 items-center justify-center rounded-lg border transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <IconX className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="border-border/60 bg-muted/35 rounded-xl border px-3 py-2.5">
            <div className="text-muted-foreground">Status</div>
            <div className="mt-1 flex items-center gap-2 font-medium">
              <StatusGlyph node={node} />
              <span>{activityStatusLabel(node.status)}</span>
            </div>
          </div>
          <div className="border-border/60 bg-muted/35 rounded-xl border px-3 py-2.5">
            <div className="text-muted-foreground">Duration</div>
            <div className="mt-1 flex items-center gap-1.5 font-medium">
              <IconClock className="text-primary size-3.5" />
              {formatActivityDuration(node.durationMs)}
            </div>
          </div>
          <div className="border-border/60 bg-muted/35 rounded-xl border px-3 py-2.5">
            <div className="text-muted-foreground">Started</div>
            <div className="mt-1 font-medium">
              {formatActivityTime(node.createdAt) || "—"}
            </div>
          </div>
          <div className="border-border/60 bg-muted/35 rounded-xl border px-3 py-2.5">
            <div className="text-muted-foreground">Planner level</div>
            <div className="mt-1 font-medium">{node.level + 1}</div>
          </div>
        </div>

        {node.parallel && (
          <div className="border-primary/20 bg-primary/[0.07] text-primary mt-3 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-[11px]">
            <IconRefresh className="size-3.5" />
            Running in parallel with sibling activities
          </div>
        )}

        <div className="mt-4 space-y-3">
          {action && <InspectorBlock label="Action" value={action} />}
          {input && <InspectorBlock label="Input" value={input} code />}
          {result && <InspectorBlock label="Result" value={result} />}
          {output && (
            <InspectorBlock label="Output preview" value={output} code />
          )}
          {node.error && (
            <InspectorBlock label="Error" value={node.error} tone="danger" />
          )}
          {!action && !input && !result && !output && !node.error && (
            <div className="border-border/70 text-muted-foreground flex items-start gap-2 rounded-xl border border-dashed px-3 py-3 text-[11px] leading-5">
              <IconInfoCircle className="text-primary mt-0.5 size-3.5 shrink-0" />
              Detailed activity output will appear here as Miki receives live
              execution events.
            </div>
          )}
        </div>

        <div className="border-border/60 text-muted-foreground mt-4 space-y-2 border-t pt-3 text-[11px]">
          <div className="flex items-center justify-between gap-3">
            <span>Run</span>
            <span className="truncate font-mono" title={run?.id}>
              {run?.id?.slice(0, 18) || "—"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Node</span>
            <span className="truncate font-mono" title={node.id}>
              {node.id.slice(-18)}
            </span>
          </div>
          {node.attempt !== undefined && (
            <div className="flex items-center justify-between gap-3">
              <span>Attempt</span>
              <span className="font-mono">{node.attempt}</span>
            </div>
          )}
        </div>
      </div>

      <Link
        to="/"
        onClick={() => selectMonitorNode(undefined)}
        className="border-border/70 text-muted-foreground hover:border-primary/35 hover:bg-primary/[0.07] hover:text-foreground m-3 inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-[12px] font-medium transition-colors"
      >
        <IconExternalLink className="size-3.5" />
        Open conversation
      </Link>
    </aside>
  )
}

function InspectorBlock({
  label,
  value,
  code = false,
  tone = "default",
}: {
  label: string
  value: string
  code?: boolean
  tone?: "default" | "danger"
}) {
  return (
    <section
      className={cn(
        "rounded-xl border px-3 py-2.5",
        tone === "danger"
          ? "border-destructive/25 bg-destructive/[0.07]"
          : "border-border/60 bg-muted/25",
      )}
    >
      <div
        className={cn(
          "text-[10px] font-semibold tracking-[0.14em] uppercase",
          tone === "danger" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {label}
      </div>
      {code ? (
        <pre className="text-foreground/75 mt-2 max-h-36 overflow-auto font-mono text-[10px] leading-4 break-words whitespace-pre-wrap">
          {value}
        </pre>
      ) : (
        <p className="text-foreground/75 mt-1.5 text-[11px] leading-5 break-words whitespace-pre-wrap">
          {value}
        </p>
      )}
    </section>
  )
}

function MonitorWorkspace() {
  const state = useAtomValue(monitorAtom)
  const runs = useMemo(
    () => Object.values(state.runs).sort((a, b) => b.startedAt - a.startedAt),
    [state.runs],
  )
  const nodes = useMemo(
    () => Object.values(state.nodes).sort((a, b) => a.createdAt - b.createdAt),
    [state.nodes],
  )
  const selectedRun = state.selectedRunId
    ? runs.find((run) => run.id === state.selectedRunId)
    : runs[0]
  const selectedNode = state.selectedNodeId
    ? state.nodes[state.selectedNodeId]
    : undefined
  if (nodes.length === 0) {
    return (
      <div
        className="bg-background h-full min-h-0"
        aria-label="Agent Inspector"
      />
    )
  }

  return (
    <main className="bg-background relative h-full min-h-0 min-w-0 overflow-hidden">
      <ReactFlowProvider>
        <CanvasInner selectedNodeId={state.selectedNodeId} />
      </ReactFlowProvider>

      {selectedNode && (
        <ActivityInspector node={selectedNode} run={selectedRun} />
      )}
    </main>
  )
}

/**
 * The live monitoring workspace. The graph is driven exclusively by node.*
 * websocket events, while the canvas keeps the conversation surface available
 * and opens details only when a specific activity is selected.
 */
export function MonitorCanvas() {
  return <MonitorWorkspace />
}
