import { describe, expect, it } from "vitest"

import type { ChatMessage } from "@/store/chat"
import { getRenderableChatMessages } from "./renderable-chat-messages"

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  replyToMessageId?: string,
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: 1,
    ...(role === "assistant" ? { kind: "normal" as const } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
  }
}

describe("getRenderableChatMessages", () => {
  it("preserves chronological order when an active run receives a follow-up", () => {
    const result = getRenderableChatMessages([
      message("user-1", "user", "First prompt"),
      message("assistant-progress", "assistant", "Working on it"),
      message("user-2", "user", "A follow-up while Miki is working"),
      // The run still references its original prompt, but this reply was
      // created after the follow-up and must remain below it in the transcript.
      message("assistant-final", "assistant", "Final answer", "user-1"),
    ])

    expect(result.map((item) => item.id)).toEqual([
      "user-1",
      "assistant-progress",
      "user-2",
      "assistant-final",
    ])
  })

  it("preserves the server/store order for ordinary prompt and reply pairs", () => {
    const result = getRenderableChatMessages([
      message("user-1", "user", "First prompt"),
      message("assistant-1", "assistant", "First reply", "user-1"),
      message("user-2", "user", "Second prompt"),
      message("assistant-2", "assistant", "Second reply", "user-2"),
    ])

    expect(result.map((item) => item.id)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2",
    ])
  })

  it("keeps an assistant reply visible after its user prompt is deleted", () => {
    const result = getRenderableChatMessages([
      message("assistant-1", "assistant", "Reply remains", "deleted-user"),
      message("user-2", "user", "Another chat message"),
    ])

    expect(result.map((item) => item.id)).toEqual(["assistant-1", "user-2"])
  })

  it("does not expose runtime and notification messages in the conversation", () => {
    const notification = {
      ...message("notice", "assistant", "Background notice"),
      notificationKind: "result",
    }
    const thought = {
      ...message("thought", "assistant", "Internal thought"),
      kind: "thought" as const,
    }

    expect(
      getRenderableChatMessages([
        message("user-1", "user", "Visible"),
        notification,
        thought,
      ]).map((item) => item.id),
    ).toEqual(["user-1"])
  })
})
