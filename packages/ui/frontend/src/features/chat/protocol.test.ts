import { beforeEach, describe, expect, it, vi } from "vitest"

import { handlePicoMessage } from "./protocol"
import { getChatState, updateChatStore } from "@/store/chat"

const { toastError } = vi.hoisted(() => ({
  toastError: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: {
    error: toastError,
  },
}))

function resetChatState() {
  updateChatStore({
    messages: [],
    connectionState: "connected",
    isTyping: false,
    activeSessionId: "session-1",
    hasHydratedActiveSession: true,
    contextUsage: undefined,
  })
  toastError.mockClear()
}

describe("chat protocol flow", () => {
  beforeEach(() => {
    resetChatState()
  })

  it("creates assistant messages with attachments, model, context usage, and typing state", () => {
    updateChatStore({ isTyping: true })

    handlePicoMessage(
      {
        type: "message.create",
        session_id: "session-1",
        timestamp: 1_700_000_000,
        payload: {
          message_id: "assistant-1",
          content: "Hello",
          model_name: " gpt-4.1-mini ",
          context_usage: {
            used_tokens: 120,
            total_tokens: 1000,
            compress_at_tokens: 850,
            used_percent: 12,
          },
          attachments: [
            {
              type: "image",
              url: "/pico/media/cat.png",
              filename: "cat.png",
              content_type: "image/png",
            },
            { type: "ignored" },
          ],
        },
      },
      "session-1",
    )

    const state = getChatState()
    expect(state.isTyping).toBe(false)
    expect(state.contextUsage).toMatchObject({
      used_tokens: 120,
      total_tokens: 1000,
    })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({
      id: "assistant-1",
      role: "assistant",
      content: "Hello",
      kind: "normal",
      modelName: "gpt-4.1-mini",
      attachments: [
        {
          type: "image",
          url: "/pico/media/cat.png",
          filename: "cat.png",
          contentType: "image/png",
        },
      ],
      timestamp: 1_700_000_000_000,
    })
  })

  it("updates, creates missing updates, deletes, and ignores other sessions", () => {
    handlePicoMessage(
      {
        type: "message.create",
        session_id: "session-1",
        payload: { message_id: "assistant-1", content: "Draft" },
      },
      "session-1",
    )

    handlePicoMessage(
      {
        type: "message.update",
        session_id: "session-1",
        payload: { message_id: "assistant-1", content: "Final" },
      },
      "session-1",
    )

    handlePicoMessage(
      {
        type: "message.update",
        session_id: "session-1",
        payload: { message_id: "assistant-2", content: "Late arrival" },
      },
      "session-1",
    )

    handlePicoMessage(
      {
        type: "message.create",
        session_id: "other-session",
        payload: { message_id: "ignored", content: "Ignore me" },
      },
      "session-1",
    )

    expect(getChatState().messages.map((message) => message.content)).toEqual([
      "Final",
      "Late arrival",
    ])

    handlePicoMessage(
      {
        type: "message.delete",
        session_id: "session-1",
        payload: { message_id: "assistant-1" },
      },
      "session-1",
    )

    expect(getChatState().messages.map((message) => message.id)).toEqual([
      "assistant-2",
    ])
  })

  it("handles typing and error messages by clearing pending request state", () => {
    updateChatStore({
      messages: [
        {
          id: "request-1",
          role: "user",
          content: "send",
          timestamp: 1,
        },
      ],
    })

    handlePicoMessage({ type: "typing.start", session_id: "session-1" }, "session-1")
    expect(getChatState().isTyping).toBe(true)

    handlePicoMessage(
      {
        type: "error",
        session_id: "session-1",
        payload: {
          request_id: "request-1",
          message: "Gateway disconnected",
        },
      },
      "session-1",
    )

    expect(toastError).toHaveBeenCalledWith("Gateway disconnected")
    expect(getChatState().isTyping).toBe(false)
    expect(getChatState().messages).toEqual([])
  })
})
