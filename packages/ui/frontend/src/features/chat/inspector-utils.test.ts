import { describe, expect, it } from "vitest"

import type { ChatMessage } from "@/store/chat"
import {
  formatInspectorTime,
  getLatestAssistantResponse,
  getMessageRunIds,
  parseInspectorTimestamp,
  scopeActivityNodes,
} from "./inspector-utils"

function message(
  id: string,
  role: ChatMessage["role"],
  timestamp: ChatMessage["timestamp"],
  kind: ChatMessage["kind"] = "normal",
  content = id,
): ChatMessage {
  return { id, role, timestamp, kind, content }
}

describe("inspector timestamp helpers", () => {
  it("supports seconds, milliseconds, numeric strings and ISO strings", () => {
    expect(parseInspectorTimestamp(1_700_000_000)).toBe(1_700_000_000_000)
    expect(parseInspectorTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(parseInspectorTimestamp("1700000000")).toBe(1_700_000_000_000)
    expect(
      parseInspectorTimestamp("2023-11-14T22:13:20.000Z"),
    ).toBe(1_700_000_000_000)
  })

  it("shows a safe fallback for invalid values", () => {
    expect(parseInspectorTimestamp("not a date")).toBeUndefined()
    expect(formatInspectorTime("not a date")).toBe("—")
  })
})

describe("getLatestAssistantResponse", () => {
  it("returns the newest user-facing response rather than the first assistant message", () => {
    const messages = [
      message("user-1", "user", 1_700_000_000),
      message("assistant-old", "assistant", 1_700_000_001),
      message("thought", "assistant", 1_700_000_003, "thought"),
      message("tool", "assistant", 1_700_000_004, "tool_calls"),
      message("assistant-new", "assistant", 1_700_000_005),
    ]

    expect(getLatestAssistantResponse(messages)?.id).toBe("assistant-new")
  })

  it("uses array order when timestamps are missing or invalid", () => {
    const messages = [
      message("assistant-old", "assistant", "invalid"),
      message("assistant-new", "assistant", "also invalid"),
    ]

    expect(getLatestAssistantResponse(messages)?.id).toBe("assistant-new")
  })
})


describe("activity run scoping", () => {
  it("only returns nodes linked to the current chat messages", () => {
    const messages = [
      { ...message("a", "assistant", 1_700_000_000), runId: "run-a" },
      { ...message("b", "assistant", 1_700_000_001), runId: "run-b" },
    ]
    const nodes = [
      { id: "node-a", runId: "run-a" },
      { id: "node-b", runId: "run-b" },
      { id: "other-chat", runId: "run-other" },
    ]

    expect(
      scopeActivityNodes(nodes, getMessageRunIds(messages)).map((node) => node.id),
    ).toEqual(["node-a", "node-b"])
  })

  it("returns no nodes when messages have no run identity", () => {
    const messages = [message("a", "assistant", 1_700_000_000)]
    expect(
      scopeActivityNodes(
        [{ id: "other-chat", runId: "run-other" }],
        getMessageRunIds(messages),
      ),
    ).toEqual([])
  })
})
