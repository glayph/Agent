import { beforeEach, describe, expect, it, vi } from "vitest"

import { editChatMessage } from "./controller"
import { getChatState, updateChatStore } from "@/store/chat"

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}))

function resetChatState() {
  updateChatStore({
    messages: [
      {
        id: "user-1",
        role: "user",
        content: "Original",
        timestamp: 1,
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "Answer",
        timestamp: 2,
        kind: "normal",
        modelName: "gpt-4o",
      },
    ],
    connectionState: "connected",
    isTyping: false,
    activeSessionId: "session-1",
    hasHydratedActiveSession: true,
    contextUsage: undefined,
  })
}

describe("chat controller message editing", () => {
  beforeEach(() => {
    resetChatState()
  })

  it("updates an existing message in place without appending a new message", () => {
    const edited = editChatMessage({
      messageId: "user-1",
      content: "  Edited message  ",
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,abc",
          filename: "edited.png",
        },
        {
          type: "file",
          url: "/ignored.txt",
          filename: "ignored.txt",
        },
      ],
    })

    const state = getChatState()

    expect(edited).toBe(true)
    expect(state.messages).toHaveLength(2)
    expect(state.messages[0]).toMatchObject({
      id: "user-1",
      role: "user",
      content: "Edited message",
      timestamp: 1,
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,abc",
          filename: "edited.png",
        },
      ],
    })
    expect(state.messages[1]).toMatchObject({
      id: "assistant-1",
      content: "Answer",
      modelName: "gpt-4o",
    })
  })

  it("does not mutate state for empty or missing message edits", () => {
    expect(
      editChatMessage({ messageId: "user-1", content: "   " }),
    ).toBe(false)
    expect(
      editChatMessage({ messageId: "missing", content: "Edited" }),
    ).toBe(false)

    expect(getChatState().messages.map((message) => message.content)).toEqual([
      "Original",
      "Answer",
    ])
  })
})
