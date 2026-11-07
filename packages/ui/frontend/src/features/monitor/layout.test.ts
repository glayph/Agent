import { describe, expect, it } from "vitest"

import type { MonitorEdge, MonitorNode } from "@/features/monitor/store"
import { MONITOR_NODE_DIMENSIONS } from "@/features/monitor/node-visuals.constants"

import { computeLayout, toReactFlowEdges, toReactFlowNodes } from "./layout"

function node(
  id: string,
  uiState: MonitorNode["uiState"] = "minimized",
): MonitorNode {
  return {
    id,
    runId: "run-1",
    type: "tool",
    label: id,
    status: "running",
    level: 0,
    parallel: false,
    createdAt: 1,
    updatedAt: 1,
    uiState,
  }
}

function edge(source: string, target: string): MonitorEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    runId: "run-1",
    animated: false,
  }
}

describe("monitor graph layout", () => {
  it("uses the same node dimensions as the rendered cards", () => {
    expect(MONITOR_NODE_DIMENSIONS).toEqual({
      minimized: { width: 56, height: 56 },
      expanded: { width: 268, height: 168 },
    })
  })

  it("places connected nodes at distinct positions and keeps manual positions", () => {
    const manual = {
      ...node("manual"),
      position: { x: 900, y: 300 },
      hasManualPosition: true,
    }
    const input = [node("root"), node("child"), node("grandchild"), manual]
    const result = computeLayout(input, [
      edge("root", "child"),
      edge("child", "grandchild"),
    ])
    const positions = new Map(result.nodes.map((item) => [item.id, item.position]))

    expect(positions.get("root")).toBeDefined()
    expect(positions.get("child")).toBeDefined()
    expect(positions.get("grandchild")).toBeDefined()
    expect(positions.get("root")).not.toEqual(positions.get("child"))
    expect(positions.get("child")).not.toEqual(positions.get("grandchild"))
    expect(positions.get("root")!.x).toBeLessThan(positions.get("child")!.x)
    expect(positions.get("child")!.x).toBeLessThan(positions.get("grandchild")!.x)
    expect(positions.get("manual")).toEqual({ x: 900, y: 300 })
  })

  it("moves newly spawned auto nodes away from manual node rectangles", () => {
    const manual = {
      ...node("manual"),
      position: { x: 0, y: 0 },
      hasManualPosition: true,
    }
    const spawned = node("spawned")
    const result = computeLayout([manual, spawned], [])
    const manualSize = MONITOR_NODE_DIMENSIONS[manual.uiState]
    const spawnedSize = MONITOR_NODE_DIMENSIONS[spawned.uiState]
    const manualPosition = result.nodes.find((item) => item.id === "manual")?.position
    const spawnedPosition = result.nodes.find((item) => item.id === "spawned")?.position

    expect(manualPosition).toEqual({ x: 0, y: 0 })
    expect(spawnedPosition).toBeDefined()
    expect(
      (spawnedPosition!.x >= manualPosition!.x + manualSize.width + 32)
        || (spawnedPosition!.x + spawnedSize.width + 32 <= manualPosition!.x)
        || (spawnedPosition!.y >= manualPosition!.y + manualSize.height + 32)
        || (spawnedPosition!.y + spawnedSize.height + 32 <= manualPosition!.y),
    ).toBe(true)
    expect(spawnedSize).toMatchObject({ width: 56, height: 56 })
  })

  it("passes semantic source and target IDs through to React Flow", () => {
    const nodes = computeLayout(
      [node("root"), node("child")],
      [edge("root", "child")],
    ).nodes
    const flowNodes = toReactFlowNodes(nodes)
    const flowEdges = toReactFlowEdges([edge("root", "child")])

    expect(flowNodes.map((item) => item.id)).toEqual(["root", "child"])
    expect(flowNodes[0]).toMatchObject({ sourcePosition: "right", targetPosition: "left" })
    expect(flowEdges).toHaveLength(1)
    expect(flowEdges[0]).toMatchObject({
      id: "root->child",
      source: "root",
      target: "child",
      sourceHandle: "source",
      targetHandle: "target",
      type: "flowEdge",
      data: { animated: false },
    })
  })
})
