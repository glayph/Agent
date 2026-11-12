import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { mikiMessage } from "@/features/chat/protocol"

import { handleMonitorMessage, resetMonitorProtocolLifecycle } from "./protocol"
import { getMonitorState, hydrateMonitorHistory, resetMonitorStore } from "./store"

function msg(type: string, payload: Record<string, unknown>): mikiMessage {
  return { type, payload }
}

beforeEach(() => {
  resetMonitorProtocolLifecycle()
  resetMonitorStore()
})

afterEach(() => {
  vi.useRealTimers()
  resetMonitorProtocolLifecycle()
})

describe("handleMonitorMessage: node.run_start", () => {
  it("creates a running run entry", () => {
    handleMonitorMessage(
      msg("node.run_start", { run_id: "run-1", objective: "Fix the bug" }),
    )
    const run = getMonitorState().runs["run-1"]
    expect(run).toMatchObject({
      id: "run-1",
      objective: "Fix the bug",
      status: "running",
    })
    expect(typeof run.startedAt).toBe("number")
  })

  it("is ignored when run_id is missing", () => {
    handleMonitorMessage(msg("node.run_start", {}))
    expect(getMonitorState().runs).toEqual({})
  })
})

describe("handleMonitorMessage: node.plan", () => {
  it("attaches plan metadata to an existing run", () => {
    handleMonitorMessage(msg("node.run_start", { run_id: "run-1" }))
    handleMonitorMessage(
      msg("node.plan", {
        run_id: "run-1",
        total: 4,
        levels: 2,
        acceleration_mode: "parallel",
        speed_class: "fast",
      }),
    )
    const run = getMonitorState().runs["run-1"]
    expect(run.planTotal).toBe(4)
    expect(run.planLevels).toBe(2)
    expect(run.accelerationMode).toBe("parallel")
    expect(run.speedClass).toBe("fast")
  })

  it("is ignored when the run does not exist yet", () => {
    handleMonitorMessage(msg("node.plan", { run_id: "unknown", total: 4 }))
    expect(getMonitorState().runs["unknown"]).toBeUndefined()
  })
})

describe("handleMonitorMessage: node.spawn", () => {
  it("creates a running node classified by its tool-name label", () => {
    handleMonitorMessage(
      msg("node.spawn", {
        run_id: "run-1",
        node_id: "node-1",
        label: "plugin_hubspot_create_contact",
        level: 0,
        parallel: false,
      }),
    )
    const node = getMonitorState().nodes["node-1"]
    expect(node).toMatchObject({
      id: "node-1",
      runId: "run-1",
      type: "plugin",
      label: "plugin_hubspot_create_contact",
      status: "running",
      level: 0,
      uiState: "minimized",
    })
  })

  it("classifies skill, file, and command labels distinctly", () => {
    handleMonitorMessage(
      msg("node.spawn", { run_id: "r", node_id: "n1", label: "skill_search" }),
    )
    handleMonitorMessage(
      msg("node.spawn", { run_id: "r", node_id: "n2", label: "file_read" }),
    )
    handleMonitorMessage(
      msg("node.spawn", {
        run_id: "r",
        node_id: "n3",
        label: "shell_execute",
      }),
    )
    handleMonitorMessage(
      msg("node.spawn", { run_id: "r", node_id: "n4", label: "web_search" }),
    )
    const { nodes } = getMonitorState()
    expect(nodes["n1"].type).toBe("skill")
    expect(nodes["n2"].type).toBe("file")
    expect(nodes["n3"].type).toBe("terminal")
    expect(nodes["n4"].type).toBe("search")
  })

  it("defaults an unlabeled node to the literal string 'unknown'", () => {
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "n1" }))
    expect(getMonitorState().nodes["n1"].label).toBe("unknown")
  })

  it("keeps a queued node pending until the tool actually starts", () => {
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "n1", label: "file_read", status: "pending" }))
    expect(getMonitorState().nodes["n1"].status).toBe("pending")
    handleMonitorMessage(msg("node.update", { node_id: "n1", status: "running" }))
    expect(getMonitorState().nodes["n1"].status).toBe("running")
  })

  it("adds the node id to nodeOrder exactly once even if spawned twice", () => {
    handleMonitorMessage(
      msg("node.spawn", { run_id: "r", node_id: "n1", label: "shell_execute" }),
    )
    handleMonitorMessage(
      msg("node.spawn", { run_id: "r", node_id: "n1", label: "shell_execute" }),
    )
    expect(getMonitorState().nodeOrder).toEqual(["n1"])
  })

  it("connects nodes only to their explicit semantic parents, not every node in a prior level", () => {
    handleMonitorMessage(msg("node.run_start", { run_id: "run-1" }))
    handleMonitorMessage(msg("node.spawn", { run_id: "run-1", node_id: "run-1:root", node_type: "goal", label: "Goal", parent_node_ids: [] }))
    handleMonitorMessage(msg("node.spawn", { run_id: "run-1", node_id: "run-1:a", label: "tool_a", parent_node_ids: ["run-1:root"], level: 0 }))
    handleMonitorMessage(msg("node.spawn", { run_id: "run-1", node_id: "run-1:b", label: "tool_b", parent_node_ids: ["run-1:root"], level: 0 }))
    handleMonitorMessage(msg("node.spawn", { run_id: "run-1", node_id: "run-1:c", label: "tool_c", parent_node_ids: ["run-1:a"], level: 1 }))
    const { edges } = getMonitorState()
    expect(edges["run-1:a->run-1:c"]).toMatchObject({ source: "run-1:a", target: "run-1:c", runId: "run-1", animated: true })
    expect(edges["run-1:b->run-1:c"]).toBeUndefined()
    expect(edges["run-1:a->run-1:b"]).toBeUndefined()
    expect(edges["run-1:root->run-1:a"]).toBeDefined()
    expect(edges["run-1:root->run-1:b"]).toBeDefined()
  })

  it("resolves a dependency when its parent node arrives later", () => {
    handleMonitorMessage(msg("node.run_start", { run_id: "r" }))
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "r:root", node_type: "goal", label: "Goal", parent_node_ids: [] }))
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "r:child", label: "child_tool", parent_node_ids: ["r:parent"] }))
    expect(getMonitorState().edges["r:parent->r:child"]).toBeUndefined()
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "r:parent", label: "parent_tool", parent_node_ids: ["r:root"] }))
    expect(getMonitorState().edges["r:parent->r:child"]).toMatchObject({ source: "r:parent", target: "r:child" })
  })

  it("anchors a child to the run root when its declared parent never arrives, then replaces the fallback when it does", () => {
    handleMonitorMessage(msg("node.run_start", { run_id: "r" }))
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "r:root", node_type: "goal", label: "Goal", parent_node_ids: [] }))
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "r:child", label: "browser_navigate", parent_node_ids: ["r:missing-plan-step"] }))

    expect(getMonitorState().edges["r:root->r:child"]).toMatchObject({
      source: "r:root", target: "r:child", displayOnly: true,
    })

    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "r:missing-plan-step", label: "Research", parent_node_ids: ["r:root"] }))
    expect(getMonitorState().edges["r:missing-plan-step->r:child"]).toMatchObject({
      source: "r:missing-plan-step", target: "r:child",
    })
    expect(getMonitorState().edges["r:root->r:child"]).toBeUndefined()
  })

  it("does not create cross-run dependency edges", () => {
    handleMonitorMessage(msg("node.run_start", { run_id: "run-1" }))
    handleMonitorMessage(msg("node.run_start", { run_id: "run-2" }))
    handleMonitorMessage(msg("node.spawn", { run_id: "run-1", node_id: "run-1:root", node_type: "goal", label: "Goal", parent_node_ids: [] }))
    handleMonitorMessage(msg("node.spawn", { run_id: "run-2", node_id: "run-2:root", node_type: "goal", label: "Goal", parent_node_ids: [] }))
    handleMonitorMessage(msg("node.spawn", { run_id: "run-1", node_id: "run-1:a", label: "tool_a", parent_node_ids: ["run-1:root"] }))
    handleMonitorMessage(msg("node.spawn", { run_id: "run-2", node_id: "run-2:c", label: "tool_c", parent_node_ids: ["run-1:a"] }))
    expect(getMonitorState().edges["run-1:a->run-2:c"]).toBeUndefined()
    expect(getMonitorState().nodes["run-2:c"].parentNodeIds).toEqual(["run-2:root"])
  })

  it("uses trusted icon and display metadata supplied by the runtime", () => {
    handleMonitorMessage(msg("node.run_start", { run_id: "r" }))
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "browser-1", label: "browser_navigate", node_type: "browser", icon_key: "browser", display_name: "Browser", tool_name: "browser_navigate" }))
    expect(getMonitorState().nodes["browser-1"]).toMatchObject({ type: "browser", iconKey: "browser", displayName: "Browser", toolName: "browser_navigate" })
  })

  it("is ignored when run_id or node_id is missing", () => {
    handleMonitorMessage(msg("node.spawn", { node_id: "n1", label: "x" }))
    handleMonitorMessage(msg("node.spawn", { run_id: "r", label: "x" }))
    expect(getMonitorState().nodes).toEqual({})
  })
})

describe("handleMonitorMessage: node.update", () => {
  it("updates status and attempt count on an existing node", () => {
    handleMonitorMessage(
      msg("node.spawn", { run_id: "r", node_id: "n1", label: "shell_execute" }),
    )
    handleMonitorMessage(
      msg("node.update", { node_id: "n1", status: "retrying", attempt: 2 }),
    )
    const node = getMonitorState().nodes["n1"]
    expect(node.status).toBe("retrying")
    expect(node.attempt).toBe(2)
  })

  it("animates incoming dependency edges when a pending tool starts", () => {
    handleMonitorMessage(msg("node.run_start", { run_id: "r" }))
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "r:root", node_type: "goal", label: "Goal", parent_node_ids: [] }))
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "r:tool", label: "browser_navigate", status: "pending", parent_node_ids: ["r:root"] }))
    expect(getMonitorState().edges["r:root->r:tool"].animated).toBe(false)
    handleMonitorMessage(msg("node.update", { run_id: "r", node_id: "r:tool", status: "running" }))
    expect(getMonitorState().edges["r:root->r:tool"].animated).toBe(true)
    handleMonitorMessage(msg("node.update", { run_id: "r", node_id: "r:tool", status: "completed" }))
    expect(getMonitorState().edges["r:root->r:tool"].animated).toBe(false)
  })

  it("is ignored for an unknown node", () => {
    handleMonitorMessage(
      msg("node.update", { node_id: "missing", status: "retrying" }),
    )
    expect(getMonitorState().nodes["missing"]).toBeUndefined()
  })
})

describe("handleMonitorMessage: node.complete", () => {
  it("marks a successful node completed and stops incoming edge animation", () => {
    handleMonitorMessage(msg("node.run_start", { run_id: "r" }))
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "r:root", node_type: "goal", label: "Goal", parent_node_ids: [] }))
    handleMonitorMessage(
      msg("node.spawn", {
        run_id: "r",
        node_id: "r:a",
        label: "tool_a",
        parent_node_ids: ["r:root"],
        level: 0,
      }),
    )
    handleMonitorMessage(
      msg("node.spawn", {
        run_id: "r",
        node_id: "r:b",
        label: "tool_b",
        parent_node_ids: ["r:a"],
        level: 1,
      }),
    )
    handleMonitorMessage(
      msg("node.complete", {
        node_id: "r:b",
        ok: true,
        duration_ms: 120,
        result_message: "done",
      }),
    )
    const state = getMonitorState()
    expect(state.nodes["r:b"]).toMatchObject({
      status: "completed",
      durationMs: 120,
      resultMessage: "done",
    })
    expect(state.nodes["r:b"].error).toBeUndefined()
    expect(state.edges["r:a->r:b"].animated).toBe(false)
  })

  it("marks a failed node failed, records an error, and stops its outgoing edges too", () => {
    handleMonitorMessage(msg("node.run_start", { run_id: "r" }))
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "r:root", node_type: "goal", label: "Goal", parent_node_ids: [] }))
    handleMonitorMessage(
      msg("node.spawn", {
        run_id: "r",
        node_id: "r:a",
        label: "tool_a",
        parent_node_ids: ["r:root"],
        level: 0,
      }),
    )
    handleMonitorMessage(
      msg("node.spawn", {
        run_id: "r",
        node_id: "r:b",
        label: "tool_b",
        parent_node_ids: ["r:a"],
        level: 1,
      }),
    )
    handleMonitorMessage(
      msg("node.spawn", {
        run_id: "r",
        node_id: "r:c",
        label: "tool_c",
        parent_node_ids: ["r:b"],
        level: 2,
      }),
    )
    handleMonitorMessage(
      msg("node.complete", {
        node_id: "r:b",
        ok: false,
        result_message: "permission denied",
      }),
    )
    const state = getMonitorState()
    expect(state.nodes["r:b"].status).toBe("failed")
    expect(state.nodes["r:b"].error).toBe("permission denied")
    // Incoming edge (a->b) stops because b settled.
    expect(state.edges["r:a->r:b"].animated).toBe(false)
    // Outgoing edge (b->c) also stops because b failed.
    expect(state.edges["r:b->r:c"].animated).toBe(false)
  })

  it("is ignored for an unknown node", () => {
    handleMonitorMessage(msg("node.complete", { node_id: "missing", ok: true }))
    expect(getMonitorState().nodes["missing"]).toBeUndefined()
  })
})

describe("live graph lifecycle", () => {
  it("removes completed nodes after the exit transition and reconnects active descendants", () => {
    vi.useFakeTimers()
    handleMonitorMessage(msg("node.run_start", { run_id: "r" }))
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "r:root", node_type: "goal", label: "Goal", parent_node_ids: [] }))
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "r:step", node_type: "workflow", label: "Plan step", parent_node_ids: ["r:root"] }))
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "r:tool", node_type: "browser", label: "browser_navigate", parent_node_ids: ["r:step"] }))
    handleMonitorMessage(msg("node.complete", { run_id: "r", node_id: "r:step", ok: true }))
    expect(getMonitorState().nodes["r:step"].status).toBe("completed")
    vi.advanceTimersByTime(800)
    expect(getMonitorState().nodes["r:step"]).toBeUndefined()
    expect(getMonitorState().nodes["r:tool"]).toBeDefined()
    expect(Object.values(getMonitorState().edges)).toContainEqual(expect.objectContaining({ source: "r:root", target: "r:tool", displayOnly: true }))
  })

  it("clears the entire live run after its completion transition", () => {
    vi.useFakeTimers()
    handleMonitorMessage(msg("node.run_start", { run_id: "r" }))
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "r:root", node_type: "goal", label: "Goal", parent_node_ids: [] }))
    handleMonitorMessage(msg("node.run_end", { run_id: "r", status: "completed" }))
    expect(getMonitorState().nodes["r:root"]).toMatchObject({ status: "completed" })
    expect(Object.values(getMonitorState().edges).every((edge) => !edge.animated)).toBe(true)
    vi.advanceTimersByTime(800)
    expect(getMonitorState().runs.r).toBeUndefined()
    expect(getMonitorState().nodes).toEqual({})
    expect(getMonitorState().edges).toEqual({})
  })

  it("restores only running runs and contracts completed intermediate nodes", () => {
    hydrateMonitorHistory({
      runs: [
        { id: "active", status: "running", startedAt: 1 },
        { id: "done", status: "completed", startedAt: 2 },
      ],
      nodes: [
        { id: "active:root", runId: "active", type: "goal", label: "Goal", status: "running", level: 0, parallel: false, createdAt: 1, updatedAt: 1 },
        { id: "active:step", runId: "active", type: "workflow", label: "Step", status: "completed", level: 1, parallel: false, createdAt: 2, updatedAt: 2 },
        { id: "active:tool", runId: "active", type: "browser", label: "Browser", status: "running", level: 2, parallel: false, createdAt: 3, updatedAt: 3 },
        { id: "done:root", runId: "done", type: "goal", label: "Goal", status: "running", level: 0, parallel: false, createdAt: 1, updatedAt: 1 },
      ],
      edges: [
        { id: "active:root->active:step", runId: "active", source: "active:root", target: "active:step" },
        { id: "active:step->active:tool", runId: "active", source: "active:step", target: "active:tool" },
      ],
    })
    const state = getMonitorState()
    expect(state.runs.done).toBeUndefined()
    expect(state.nodes["active:step"]).toBeUndefined()
    expect(state.nodes["active:tool"]).toBeDefined()
    expect(state.edges["active:root->active:tool"]).toMatchObject({ source: "active:root", target: "active:tool", displayOnly: true })
  })
})

describe("handleMonitorMessage: node.run_end", () => {
  it("marks the run completed or failed and preserves it for history", () => {
    handleMonitorMessage(msg("node.run_start", { run_id: "run-1" }))
    handleMonitorMessage(
      msg("node.run_end", { run_id: "run-1", status: "failed" }),
    )
    const run = getMonitorState().runs["run-1"]
    expect(run.status).toBe("failed")
    expect(typeof run.endedAt).toBe("number")
  })

  it("defaults to completed when status is missing", () => {
    handleMonitorMessage(msg("node.run_start", { run_id: "run-1" }))
    handleMonitorMessage(msg("node.run_end", { run_id: "run-1" }))
    expect(getMonitorState().runs["run-1"].status).toBe("completed")
  })

  it("is ignored for an unknown run", () => {
    handleMonitorMessage(msg("node.run_end", { run_id: "unknown" }))
    expect(getMonitorState().runs["unknown"]).toBeUndefined()
  })
})

  it("treats a completed-with-warning run as terminal and successful", () => {
    handleMonitorMessage(msg("node.run_start", { run_id: "run-1" }))
    handleMonitorMessage(msg("node.run_end", { run_id: "run-1", status: "completed_with_warning" }))
    expect(getMonitorState().runs["run-1"].status).toBe("completed")
  })

describe("handleMonitorMessage: unrelated/unknown message types", () => {
  it("does not throw and does not mutate state for a chat message type", () => {
    expect(() =>
      handleMonitorMessage(msg("message.create", { content: "hi" })),
    ).not.toThrow()
    const state = getMonitorState()
    expect(state.runs).toEqual({})
    expect(state.nodes).toEqual({})
  })

  it("node.metrics is accepted but intentionally does not change node state", () => {
    handleMonitorMessage(
      msg("node.spawn", { run_id: "r", node_id: "n1", label: "shell_execute" }),
    )
    const before = getMonitorState().nodes["n1"]
    handleMonitorMessage(msg("node.metrics", { node_id: "n1", cpu: 50 }))
    expect(getMonitorState().nodes["n1"]).toEqual(before)
  })
})
