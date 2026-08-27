import { beforeEach, describe, expect, it, vi } from "vitest"

import { getChatState, updateChatStore } from "@/store/chat"

import { handlemikiMessage } from "./protocol"

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
    activeRunId: undefined,
    recentRunIds: [],
    runStatus: undefined,
    runError: undefined,
  })
  toastError.mockClear()
}

describe("chat protocol flow", () => {
  beforeEach(() => {
    resetChatState()
  })

  it("creates assistant messages with attachments, model, context usage, and typing state", () => {
    updateChatStore({ isTyping: true })

    handlemikiMessage(
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
              url: "/miki/media/cat.png",
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
    expect(state).toMatchObject({
      activeRunModel: "gpt-4.1-mini",
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
          url: "/miki/media/cat.png",
          filename: "cat.png",
          contentType: "image/png",
        },
      ],
      timestamp: 1_700_000_000_000,
    })
  })

  it("renders AI-generated action updates without treating them as final replies", () => {
    handlemikiMessage(
      {
        type: "node.run_start",
        session_id: "session-1",
        payload: { run_id: "run-action" },
      },
      "session-1",
    )
    handlemikiMessage(
      {
        type: "message.create",
        session_id: "session-1",
        payload: {
          message_id: "action-1",
          run_id: "run-action",
          content: "I’ll check the page now.",
          kind: "action_update",
          action_update: true,
          placeholder: true,
        },
      },
      "session-1",
    )

    expect(getChatState().isTyping).toBe(true)
    expect(getChatState().messages[0]).toMatchObject({
      id: "action-1",
      content: "I’ll check the page now.",
      kind: "action_update",
      runId: "run-action",
    })
  })

  it("clears stale attachments when the server sends an explicit empty list", () => {
    handlemikiMessage(
      {
        type: "message.create",
        session_id: "session-1",
        payload: {
          message_id: "assistant-attachment",
          content: "with attachment",
          attachments: [{ type: "file", url: "/files/a.txt" }],
        },
      },
      "session-1",
    )
    handlemikiMessage(
      {
        type: "message.update",
        session_id: "session-1",
        payload: {
          message_id: "assistant-attachment",
          content: "without attachment",
          attachments: [],
        },
      },
      "session-1",
    )
    expect(getChatState().messages[0]?.attachments).toEqual([])
  })

  it("retains run links and safe thought metadata for Inspector grouping", () => {
    handlemikiMessage(
      {
        type: "message.create",
        session_id: "session-1",
        payload: {
          message_id: "assistant-run-1",
          run_id: "assistant-run-1",
          content: "I checked that.",
          kind: "normal",
        },
      },
      "session-1",
    )
    handlemikiMessage(
      {
        type: "message.create",
        session_id: "session-1",
        payload: {
          message_id: "assistant-run-1-thought-1",
          run_id: "assistant-run-1",
          content: "Verified the result before replying.",
          kind: "thought",
          thought_category: "Verification",
          inspector_only: true,
        },
      },
      "session-1",
    )

    expect(getChatState().messages).toMatchObject([
      { id: "assistant-run-1", runId: "assistant-run-1", kind: "normal" },
      {
        id: "assistant-run-1-thought-1",
        runId: "assistant-run-1",
        kind: "thought",
        thoughtCategory: "Verification",
        inspectorOnly: true,
      },
    ])
  })

  it("updates, creates missing updates, deletes, and ignores other sessions", () => {
    handlemikiMessage(
      {
        type: "message.create",
        session_id: "session-1",
        payload: { message_id: "assistant-1", content: "Draft" },
      },
      "session-1",
    )

    handlemikiMessage(
      {
        type: "message.update",
        session_id: "session-1",
        payload: { message_id: "assistant-1", content: "Final" },
      },
      "session-1",
    )

    handlemikiMessage(
      {
        type: "message.update",
        session_id: "session-1",
        payload: { message_id: "assistant-2", content: "Late arrival" },
      },
      "session-1",
    )

    handlemikiMessage(
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

    handlemikiMessage(
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

  it("persists run lifecycle status and warning outcomes from WebSocket events", () => {
    handlemikiMessage(
      {
        type: "node.run_start",
        session_id: "session-1",
        payload: {
          run_id: "run-1",
          model_name: "llama.cpp/lfm2.5-1.2b-instruct-q4_0",
        },
      },
      "session-1",
    )
    expect(getChatState()).toMatchObject({
      activeRunId: "run-1",
      activeRunModel: "llama.cpp/lfm2.5-1.2b-instruct-q4_0",
      activeRunProvider: "llama.cpp",
      runStatus: "running",
    })

    handlemikiMessage(
      {
        type: "node.run_end",
        session_id: "session-1",
        payload: { run_id: "run-1", status: "completed_with_warning" },
      },
      "session-1",
    )
    expect(getChatState()).toMatchObject({
      activeRunId: "run-1",
      runStatus: "completed_with_warning",
      runError: undefined,
    })

    handlemikiMessage(
      {
        type: "node.run_end",
        session_id: "session-1",
        payload: {
          run_id: "run-2",
          status: "failed",
          error: "artifact verification failed",
        },
      },
      "session-1",
    )
    expect(getChatState()).toMatchObject({
      activeRunId: "run-2",
      runStatus: "failed",
      runError: "artifact verification failed",
    })
  })

  it("ignores late lifecycle and typing events from an older active run", () => {
    handlemikiMessage(
      {
        type: "node.run_start",
        session_id: "session-1",
        payload: { run_id: "run-old", model_name: "old/model" },
      },
      "session-1",
    )
    handlemikiMessage(
      {
        type: "node.run_start",
        session_id: "session-1",
        payload: { run_id: "run-new", model_name: "new/model" },
      },
      "session-1",
    )
    handlemikiMessage(
      {
        type: "typing.start",
        session_id: "session-1",
        payload: { run_id: "run-new" },
      },
      "session-1",
    )

    handlemikiMessage(
      {
        type: "node.run_end",
        session_id: "session-1",
        payload: { run_id: "run-old", status: "failed", error: "stale" },
      },
      "session-1",
    )
    handlemikiMessage(
      {
        type: "typing.stop",
        session_id: "session-1",
        payload: { run_id: "run-old" },
      },
      "session-1",
    )

    expect(getChatState()).toMatchObject({
      activeRunId: "run-new",
      activeRunModel: "new/model",
      runStatus: "running",
      runError: undefined,
      isTyping: true,
    })

    handlemikiMessage(
      {
        type: "typing.stop",
        session_id: "session-1",
        payload: { run_id: "run-new" },
      },
      "session-1",
    )
    handlemikiMessage(
      {
        type: "node.run_end",
        session_id: "session-1",
        payload: { run_id: "run-new", status: "completed" },
      },
      "session-1",
    )
    expect(getChatState()).toMatchObject({
      activeRunId: "run-new",
      runStatus: "completed",
      isTyping: false,
    })
  })

  it("ignores stale assistant messages, run starts, typing, and errors", () => {
    handlemikiMessage(
      {
        type: "node.run_start",
        session_id: "session-1",
        payload: { run_id: "run-old", model_name: "old/model" },
      },
      "session-1",
    )
    handlemikiMessage(
      {
        type: "node.run_start",
        session_id: "session-1",
        payload: { run_id: "run-new", model_name: "new/model" },
      },
      "session-1",
    )
    handlemikiMessage(
      {
        type: "message.create",
        session_id: "session-1",
        payload: {
          message_id: "new-message",
          run_id: "run-new",
          content: "Current response",
        },
      },
      "session-1",
    )
    updateChatStore({ isTyping: true })

    handlemikiMessage(
      {
        type: "node.run_start",
        session_id: "session-1",
        payload: { run_id: "run-old", model_name: "old/model" },
      },
      "session-1",
    )
    handlemikiMessage(
      {
        type: "message.update",
        session_id: "session-1",
        payload: {
          message_id: "new-message",
          run_id: "run-old",
          content: "Stale response",
        },
      },
      "session-1",
    )
    handlemikiMessage(
      {
        type: "message.create",
        session_id: "session-1",
        payload: {
          message_id: "stale-message",
          run_id: "run-old",
          content: "Stale message",
        },
      },
      "session-1",
    )
    handlemikiMessage(
      {
        type: "typing.start",
        session_id: "session-1",
        payload: { run_id: "run-old" },
      },
      "session-1",
    )
    handlemikiMessage(
      {
        type: "typing.stop",
        session_id: "session-1",
        payload: { run_id: "run-old" },
      },
      "session-1",
    )
    handlemikiMessage(
      {
        type: "error",
        session_id: "session-1",
        payload: {
          run_id: "run-old",
          message: "stale error",
        },
      },
      "session-1",
    )

    expect(getChatState()).toMatchObject({
      activeRunId: "run-new",
      activeRunModel: "new/model",
      runStatus: "running",
      isTyping: true,
    })
    expect(getChatState().messages).toEqual([
      expect.objectContaining({
        id: "new-message",
        content: "Current response",
        runId: "run-new",
      }),
    ])
    expect(toastError).not.toHaveBeenCalledWith("stale error")
  })

  it("stores normalized delivery outcomes and keeps unknown side effects non-successful", () => {
    handlemikiMessage(
      {
        type: "delivery.outcome",
        session_id: "session-1",
        payload: {
          runId: "run-delivery",
          stepId: "step-1",
          deliveryId: "delivery-1",
          status: "reconciliation_required",
          artifactRefs: ["workspace/result.md"],
          warnings: ["provider outcome is unknown"],
          nextAction: "reconcile provider outcome before replay",
          correlationId: "corr-delivery",
          approval: {
            required: true,
            requestId: "approval-1",
            consumed: true,
          },
        },
      },
      "session-1",
    )

    expect(getChatState()).toMatchObject({
      activeRunId: "run-delivery",
      runStatus: "failed",
      runError: "reconcile provider outcome before replay",
      deliveryOutcome: {
        status: "reconciliation_required",
        deliveryId: "delivery-1",
        correlationId: "corr-delivery",
        artifactRefs: ["workspace/result.md"],
        approval: { required: true, consumed: true },
      },
    })
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

    handlemikiMessage(
      { type: "typing.start", session_id: "session-1" },
      "session-1",
    )
    expect(getChatState().isTyping).toBe(true)

    handlemikiMessage(
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
