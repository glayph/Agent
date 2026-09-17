import { beforeEach, describe, expect, it } from "vitest"

import type { mikiMessage } from "@/features/chat/protocol"

import { handleMonitorMessage } from "./protocol"
import { getMonitorState, resetMonitorStore } from "./store"

function msg(type: string, payload: Record<string, unknown>): mikiMessage {
  return { type, payload }
}

beforeEach(() => {
  resetMonitorStore()
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
    expect(nodes["n3"].type).toBe("command")
    expect(nodes["n4"].type).toBe("tool")
  })

  it("defaults an unlabeled node to the literal string 'unknown'", () => {
    handleMonitorMessage(msg("node.spawn", { run_id: "r", node_id: "n1" }))
    expect(getMonitorState().nodes["n1"].label).toBe("unknown")
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

  it("connects a level>0 node to every node in the previous level of the same run", () => {
    handleMonitorMessage(
      msg("node.spawn", {
        run_id: "run-1",
        node_id: "a",
        label: "tool_a",
        level: 0,
      }),
    )
    handleMonitorMessage(
      msg("node.spawn", {
        run_id: "run-1",
        node_id: "b",
        label: "tool_b",
        level: 0,
      }),
    )
    handleMonitorMessage(
      msg("node.spawn", {
        run_id: "run-1",
        node_id: "c",
        label: "tool_c",
        level: 1,
      }),
    )
    const { edges } = getMonitorState()
    expect(edges["a->c"]).toMatchObject({
      source: "a",
      target: "c",
      runId: "run-1",
      animated: true,
    })
    expect(edges["b->c"]).toMatchObject({
      source: "b",
      target: "c",
      runId: "run-1",
      animated: true,
    })
  })

  it("does not connect level>0 nodes across different runs", () => {
    handleMonitorMessage(
      msg("node.spawn", {
        run_id: "run-1",
        node_id: "a",
        label: "tool_a",
        level: 0,
      }),
    )
    handleMonitorMessage(
      msg("node.spawn", {
        run_id: "run-2",
        node_id: "c",
        label: "tool_c",
        level: 1,
      }),
    )
    expect(getMonitorState().edges).toEqual({})
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

  it("is ignored for an unknown node", () => {
    handleMonitorMessage(
      msg("node.update", { node_id: "missing", status: "retrying" }),
    )
    expect(getMonitorState().nodes["missing"]).toBeUndefined()
  })
})

describe("handleMonitorMessage: node.complete", () => {
  it("marks a successful node completed and stops incoming edge animation", () => {
    handleMonitorMessage(
      msg("node.spawn", { run_id: "r", node_id: "a", label: "tool_a", level: 0 }),
    )
    handleMonitorMessage(
      msg("node.spawn", { run_id: "r", node_id: "b", label: "tool_b", level: 1 }),
    )
    handleMonitorMessage(
      msg("node.complete", {
        node_id: "b",
        ok: true,
        duration_ms: 120,
        result_message: "done",
      }),
    )
    const state = getMonitorState()
    expect(state.nodes["b"]).toMatchObject({
      status: "completed",
      durationMs: 120,
      resultMessage: "done",
    })
    expect(state.nodes["b"].error).toBeUndefined()
    expect(state.edges["a->b"].animated).toBe(false)
  })

  it("marks a failed node failed, records an error, and stops its outgoing edges too", () => {
    handleMonitorMessage(
      msg("node.spawn", { run_id: "r", node_id: "a", label: "tool_a", level: 0 }),
    )
    handleMonitorMessage(
      msg("node.spawn", { run_id: "r", node_id: "b", label: "tool_b", level: 1 }),
    )
    handleMonitorMessage(
      msg("node.spawn", { run_id: "r", node_id: "c", label: "tool_c", level: 2 }),
    )
    handleMonitorMessage(
      msg("node.complete", {
        node_id: "b",
        ok: false,
        result_message: "permission denied",
      }),
    )
    const state = getMonitorState()
    expect(state.nodes["b"].status).toBe("failed")
    expect(state.nodes["b"].error).toBe("permission denied")
    // Incoming edge (a->b) stops because b settled.
    expect(state.edges["a->b"].animated).toBe(false)
    // Outgoing edge (b->c) also stops because b failed.
    expect(state.edges["b->c"].animated).toBe(false)
  })

  it("is ignored for an unknown node", () => {
    handleMonitorMessage(msg("node.complete", { node_id: "missing", ok: true }))
    expect(getMonitorState().nodes["missing"]).toBeUndefined()
  })
})

describe("handleMonitorMessage: node.run_end", () => {
  it("marks the run completed or failed and preserves it for history", () => {
    handleMonitorMessage(msg("node.run_start", { run_id: "run-1" }))
    handleMonitorMessage(msg("node.run_end", { run_id: "run-1", status: "failed" }))
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
