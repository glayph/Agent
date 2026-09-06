import { beforeEach, describe, expect, it } from "vitest"

import {
  clearMonitorRun,
  getMonitorState,
  resetMonitorStore,
  selectMonitorNode,
  selectMonitorRun,
  setNodePosition,
  toggleNodeUIState,
  updateMonitorStore,
  type MonitorNode,
} from "./store"

function baseNode(overrides: Partial<MonitorNode> = {}): MonitorNode {
  return {
    id: overrides.id ?? "node-1",
    runId: overrides.runId ?? "run-1",
    type: overrides.type ?? "tool",
    label: overrides.label ?? "shell_execute",
    status: overrides.status ?? "running",
    level: overrides.level ?? 0,
    parallel: overrides.parallel ?? false,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    uiState: overrides.uiState ?? "minimized",
    ...overrides,
  }
}

// The monitor store is a module-level jotai atom (a singleton), so every
// test must reset it first to avoid bleeding state across tests.
beforeEach(() => {
  resetMonitorStore()
})

describe("initial state", () => {
  it("starts empty with no selection", () => {
    const state = getMonitorState()
    expect(state.runs).toEqual({})
    expect(state.nodes).toEqual({})
    expect(state.edges).toEqual({})
    expect(state.nodeOrder).toEqual([])
    expect(state.selectedRunId).toBeUndefined()
    expect(state.selectedNodeId).toBeUndefined()
  })
})

describe("updateMonitorStore", () => {
  it("merges a partial object patch into state", () => {
    updateMonitorStore({ selectedRunId: "run-1" })
    expect(getMonitorState().selectedRunId).toBe("run-1")
  })

  it("merges the partial returned by an updater function computed from prev state", () => {
    updateMonitorStore({ nodes: { "node-1": baseNode() } })
    updateMonitorStore((prev) => ({
      nodeOrder: [...prev.nodeOrder, "node-1"],
    }))
    const state = getMonitorState()
    expect(state.nodes["node-1"]).toBeDefined()
    expect(state.nodeOrder).toEqual(["node-1"])
  })
})

describe("selectMonitorRun", () => {
  it("sets the selected run and clears any selected node", () => {
    updateMonitorStore({ selectedNodeId: "node-1" })
    selectMonitorRun("run-2")
    const state = getMonitorState()
    expect(state.selectedRunId).toBe("run-2")
    expect(state.selectedNodeId).toBeUndefined()
  })

  it("can clear the selection by passing undefined", () => {
    selectMonitorRun("run-2")
    selectMonitorRun(undefined)
    expect(getMonitorState().selectedRunId).toBeUndefined()
  })
})

describe("selectMonitorNode", () => {
  it("selects a node and adopts its run as the selected run", () => {
    updateMonitorStore({
      nodes: { "node-1": baseNode({ id: "node-1", runId: "run-7" }) },
    })
    selectMonitorNode("node-1")
    const state = getMonitorState()
    expect(state.selectedNodeId).toBe("node-1")
    expect(state.selectedRunId).toBe("run-7")
  })

  it("keeps the previously selected run when the node id is unknown", () => {
    updateMonitorStore({ selectedRunId: "run-existing" })
    selectMonitorNode("does-not-exist")
    const state = getMonitorState()
    expect(state.selectedNodeId).toBe("does-not-exist")
    expect(state.selectedRunId).toBe("run-existing")
  })
})

describe("toggleNodeUIState", () => {
  it("flips a node between minimized and expanded", () => {
    updateMonitorStore({
      nodes: { "node-1": baseNode({ uiState: "minimized" }) },
    })
    toggleNodeUIState("node-1")
    expect(getMonitorState().nodes["node-1"].uiState).toBe("expanded")
    toggleNodeUIState("node-1")
    expect(getMonitorState().nodes["node-1"].uiState).toBe("minimized")
  })

  it("is a no-op for an unknown node id", () => {
    updateMonitorStore({ nodes: { "node-1": baseNode() } })
    toggleNodeUIState("missing-node")
    expect(getMonitorState().nodes["node-1"].uiState).toBe("minimized")
  })
})

describe("setNodePosition", () => {
  it("sets an explicit position and marks it as manually placed", () => {
    updateMonitorStore({ nodes: { "node-1": baseNode() } })
    setNodePosition("node-1", { x: 10, y: 20 })
    const node = getMonitorState().nodes["node-1"]
    expect(node.position).toEqual({ x: 10, y: 20 })
    expect(node.hasManualPosition).toBe(true)
  })

  it("is a no-op for an unknown node id", () => {
    setNodePosition("missing-node", { x: 1, y: 1 })
    expect(getMonitorState().nodes["missing-node"]).toBeUndefined()
  })
})

describe("clearMonitorRun", () => {
  it("removes the run, its nodes, and edges referencing that run", () => {
    updateMonitorStore({
      runs: {
        "run-1": {
          id: "run-1",
          status: "completed",
          startedAt: 1,
        },
      },
      nodes: {
        a: baseNode({ id: "a", runId: "run-1" }),
        b: baseNode({ id: "b", runId: "run-2" }),
      },
      edges: {
        "a->b": { id: "a->b", source: "a", target: "b", runId: "run-1", animated: false },
        "b->c": { id: "b->c", source: "b", target: "c", runId: "run-2", animated: true },
      },
      nodeOrder: ["a", "b"],
    })

    clearMonitorRun("run-1")

    const state = getMonitorState()
    expect(state.runs["run-1"]).toBeUndefined()
    expect(state.nodes["a"]).toBeUndefined()
    expect(state.nodes["b"]).toBeDefined() // belongs to run-2, untouched
    expect(state.edges["a->b"]).toBeUndefined()
    expect(state.edges["b->c"]).toBeDefined() // belongs to run-2, untouched
    expect(state.nodeOrder).toEqual(["b"])
  })

  it("clears the selection if the selected node or run belonged to the cleared run", () => {
    updateMonitorStore({
      nodes: { a: baseNode({ id: "a", runId: "run-1" }) },
      selectedNodeId: "a",
      selectedRunId: "run-1",
    })
    clearMonitorRun("run-1")
    const state = getMonitorState()
    expect(state.selectedNodeId).toBeUndefined()
    expect(state.selectedRunId).toBeUndefined()
  })

  it("is a no-op when the run has no nodes and does not exist", () => {
    updateMonitorStore({
      nodes: { a: baseNode({ id: "a", runId: "run-other" }) },
    })
    clearMonitorRun("run-unknown")
    expect(getMonitorState().nodes["a"]).toBeDefined()
  })
})
