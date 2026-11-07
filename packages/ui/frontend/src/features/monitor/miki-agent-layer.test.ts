import { describe, expect, it } from "vitest"

import type { MonitorEdge, MonitorNode } from "@/features/monitor/store"
import { MIKI_AGENT_NODE_ID, withMikiAgentLayer } from "./miki-agent-layer"

function toolNode(id: string, status: MonitorNode["status"], runId = "run-1"): MonitorNode {
  return {
    id,
    runId,
    type: "tool",
    label: id,
    toolName: id,
    status,
    level: 0,
    parallel: false,
    createdAt: 10,
    updatedAt: 10,
    uiState: "minimized",
  }
}

describe("Miki Monitor agent layer", () => {
  it("keeps one always-running Miki node and connects it to each run root", () => {
    const root = { ...toolNode("run-1:root", "running"), toolName: undefined, type: "goal" as const }
    const secondRoot = { ...toolNode("run-2:root", "running", "run-2"), toolName: undefined, type: "goal" as const }
    const running = toolNode("workspace_search", "running")
    const queued = toolNode("browser_navigate", "pending", "run-2")
    const completed = toolNode("file_read", "completed")
    const existingEdge: MonitorEdge = {
      id: "run-1:root->workspace_search",
      source: "run-1:root",
      target: running.id,
      runId: "run-1",
      animated: true,
    }

    const graph = withMikiAgentLayer([root, secondRoot, running, queued, completed], [existingEdge], 123)
    const agentNodes = graph.nodes.filter((node) => node.id === MIKI_AGENT_NODE_ID)

    expect(agentNodes).toHaveLength(1)
    expect(agentNodes[0]).toMatchObject({
      label: "Miki",
      type: "agent",
      status: "running",
      uiState: "minimized",
      action: "Calling 2 tools",
    })
    expect(graph.edges).toContainEqual(existingEdge)
    expect(graph.edges).toContainEqual({
      id: `${MIKI_AGENT_NODE_ID}->${root.id}`,
      source: MIKI_AGENT_NODE_ID,
      target: root.id,
      runId: "run-1",
      animated: true,
      displayOnly: true,
    })
    expect(graph.edges).toContainEqual({
      id: `${MIKI_AGENT_NODE_ID}->${secondRoot.id}`,
      source: MIKI_AGENT_NODE_ID,
      target: secondRoot.id,
      runId: "run-2",
      animated: true,
      displayOnly: true,
    })
    expect(graph.edges.some((edge) => edge.target === completed.id)).toBe(false)
  })

  it("shows Miki while there is no tool activity", () => {
    const graph = withMikiAgentLayer([], [], 456)
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toMatchObject({
      id: MIKI_AGENT_NODE_ID,
      label: "Miki",
      status: "running",
      action: "Standing by for tool calls",
    })
    expect(graph.edges).toEqual([])
  })

  it("anchors rootless historical entries without connecting siblings together", () => {
    const first = { ...toolNode("history-a", "completed"), toolName: undefined }
    const second = { ...toolNode("history-b", "failed"), toolName: undefined }
    const graph = withMikiAgentLayer([first, second], [], 789)

    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: MIKI_AGENT_NODE_ID, target: first.id, displayOnly: true }),
      expect.objectContaining({ source: MIKI_AGENT_NODE_ID, target: second.id, displayOnly: true }),
    ]))
    expect(graph.edges.some((edge) => edge.source === first.id || edge.source === second.id)).toBe(false)
  })
})
