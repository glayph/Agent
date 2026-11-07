import { getDefaultStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { deleteSessionMessage, getSessionHistory } from "@/api/sessions"
import { getChatState, updateChatStore } from "@/store/chat"
import { gatewayAtom } from "@/store/gateway"

import {
  connectChat,
  deleteChatMessage,
  disconnectChat,
  editChatMessage,
  hydrateActiveSession,
  retryChatMessage,
  sendChatMessage,
  setWebSocketFactory,
  switchChatSession,
} from "./controller"
import { SINGLE_CHAT_SESSION_ID, writeStoredSessionId } from "./state"

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}))

vi.mock("@/api/sessions", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/sessions")>("@/api/sessions")
  return {
    ...actual,
    getSessionHistory: vi.fn(),
    deleteSessionMessage: vi.fn().mockResolvedValue(undefined),
    updateSessionMessage: vi.fn().mockResolvedValue(undefined),
  }
})

class MockWebSocket {
  url: string
  readyState = 0 // CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sentData: string[] = []

  constructor(url: string) {
    this.url = url
  }

  send(data: string) {
    this.sentData.push(data)
  }

  close() {
    this.readyState = 3 // CLOSED
    if (this.onclose) this.onclose()
  }

  simulateOpen() {
    this.readyState = 1 // OPEN
    if (this.onopen) this.onopen()
  }

  simulateMessage(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

const mockedGetSessionHistory = vi.mocked(getSessionHistory)
const mockedDeleteSessionMessage = vi.mocked(deleteSessionMessage)

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
    connectionState: "disconnected",
    isTyping: false,
    activeSessionId: "session-1",
    hasHydratedActiveSession: false,
    contextUsage: undefined,
  })
}

describe("chat controller active-session hydration", () => {
  beforeEach(() => {
    mockedGetSessionHistory.mockReset()
    writeStoredSessionId("session-1")
    updateChatStore({
      messages: [],
      activeSessionId: "session-1",
      hasHydratedActiveSession: false,
    })
  })

  afterEach(() => {
    writeStoredSessionId("")
  })

  it("hydrates the default session when localStorage has no session ID", async () => {
    writeStoredSessionId("")
    updateChatStore({
      messages: [],
      activeSessionId: SINGLE_CHAT_SESSION_ID,
      hasHydratedActiveSession: false,
    })
    mockedGetSessionHistory.mockResolvedValue({
      id: SINGLE_CHAT_SESSION_ID,
      messages: [
        {
          id: "default-history-1",
          role: "user",
          content: "Default persisted question",
          created_at: "2026-08-25T00:00:00.000Z",
        },
      ],
      summary: "Default persisted question",
      created: "2026-08-25T00:00:00.000Z",
      updated: "2026-08-25T00:00:00.000Z",
    })

    await hydrateActiveSession()

    expect(mockedGetSessionHistory).toHaveBeenCalledWith(SINGLE_CHAT_SESSION_ID)
    expect(getChatState().messages[0]?.content).toBe(
      "Default persisted question",
    )
    expect(getChatState().hasHydratedActiveSession).toBe(true)
  })

  it("coalesces concurrent hydration calls into one history request", async () => {
    let resolveHistory:
      | ((value: Awaited<ReturnType<typeof getSessionHistory>>) => void)
      | undefined
    mockedGetSessionHistory.mockReturnValue(
      new Promise((resolve) => {
        resolveHistory = resolve
      }),
    )

    const firstHydration = hydrateActiveSession()
    const secondHydration = hydrateActiveSession()
    expect(mockedGetSessionHistory).toHaveBeenCalledTimes(1)

    resolveHistory?.({
      id: "session-1",
      messages: [],
      summary: "",
      created: "2026-08-25T00:00:00.000Z",
      updated: "2026-08-25T00:00:00.000Z",
    })
    await Promise.all([firstHydration, secondHydration])
  })

  it("hydrates a stored session even when it is already the active session", async () => {
    mockedGetSessionHistory.mockResolvedValue({
      id: "session-1",
      messages: [
        {
          id: "history-user-1",
          role: "user",
          content: "Persisted question",
          created_at: "2026-08-25T00:00:00.000Z",
        },
        {
          id: "history-assistant-1",
          role: "assistant",
          content: "Persisted answer",
          created_at: "2026-08-25T00:00:01.000Z",
          kind: "normal",
        },
      ],
      summary: "Persisted question",
      created: "2026-08-25T00:00:00.000Z",
      updated: "2026-08-25T00:00:01.000Z",
    })

    await hydrateActiveSession()

    expect(mockedGetSessionHistory).toHaveBeenCalledWith("session-1")
    expect(getChatState().messages.map((message) => message.content)).toEqual([
      "Persisted question",
      "Persisted answer",
    ])
    expect(getChatState().hasHydratedActiveSession).toBe(true)
  })
})

describe("chat controller message deletion", () => {
  beforeEach(() => {
    resetChatState()
    mockedDeleteSessionMessage.mockReset().mockResolvedValue(undefined)
    updateChatStore({
      messages: [
        ...getChatState().messages,
        {
          id: "user-2",
          role: "user",
          content: "Another message must remain",
          timestamp: 3,
        },
      ],
    })
  })

  it("deletes only the selected message and preserves all other chat rows", async () => {
    expect(await deleteChatMessage("user-1")).toBe(true)

    expect(mockedDeleteSessionMessage).toHaveBeenCalledTimes(1)
    expect(mockedDeleteSessionMessage).toHaveBeenCalledWith(
      "session-1",
      "user-1",
    )
    expect(getChatState().messages.map((message) => message.id)).toEqual([
      "assistant-1",
      "user-2",
    ])
  })

  it("keeps chat state unchanged when the message delete request fails", async () => {
    mockedDeleteSessionMessage.mockRejectedValueOnce(
      new Error("delete failed"),
    )

    expect(await deleteChatMessage("user-1")).toBe(false)
    expect(getChatState().messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
    ])
  })
})

describe("chat controller message editing", () => {
  beforeEach(() => {
    resetChatState()
  })

  it("updates an existing message in place without appending a new message", async () => {
    const edited = await editChatMessage({
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
        {
          type: "file",
          url: "/ignored.txt",
          filename: "ignored.txt",
        },
      ],
    })
    expect(state.messages[1]).toMatchObject({
      id: "assistant-1",
      content: "Answer",
      modelName: "gpt-4o",
    })
  })

  it("does not mutate state for empty or missing message edits", async () => {
    expect(await editChatMessage({ messageId: "user-1", content: "   " })).toBe(
      false,
    )
    expect(
      await editChatMessage({ messageId: "missing", content: "Edited" }),
    ).toBe(false)

    expect(getChatState().messages.map((message) => message.content)).toEqual([
      "Original",
      "Answer",
    ])
  })
})

describe("chat controller WebSocket dependency injection", () => {
  let createdSockets: MockWebSocket[] = []

  beforeEach(() => {
    resetChatState()
    createdSockets = []
    const store = getDefaultStore()
    store.set(gatewayAtom, {
      status: "running",
      canStart: true,
      restartRequired: false,
      pendingRestartFields: [],
    })

    setWebSocketFactory((url: string) => {
      const mock = new MockWebSocket(url)
      createdSockets.push(mock)
      return mock as unknown as WebSocket
    })
  })

  afterEach(() => {
    disconnectChat()
    setWebSocketFactory(null)
  })

  it("connects to WebSocket endpoint with session_id parameter and updates connectionState", async () => {
    updateChatStore({ hasHydratedActiveSession: true })
    await connectChat()

    expect(createdSockets).toHaveLength(1)
    expect(createdSockets[0].url).toContain("/miki/ws?session_id=")
    expect(getChatState().connectionState).toBe("connecting")

    createdSockets[0].simulateOpen()
    expect(getChatState().connectionState).toBe("connected")
  })

  it("sends one request and adds one optimistic user message", async () => {
    updateChatStore({ hasHydratedActiveSession: true })
    await connectChat()
    createdSockets[0].simulateOpen()

    const sent = await sendChatMessage({
      content: "  Hello from the test  ",
      requestedModel: "google/gemini-3.5-flash-lite",
      requestedModelIndex: 42,
    })

    expect(sent).toBe(true)
    const messageFrame = createdSockets[0].sentData
      .map((data) => JSON.parse(data))
      .find((frame) => frame.type === "message.send")
    expect(messageFrame).toBeDefined()
    expect(messageFrame).toMatchObject({
      type: "message.send",
      id: expect.stringMatching(/^msg-/),
      payload: {
        content: "Hello from the test",
        media: [],
        requested_model: "google/gemini-3.5-flash-lite",
        requested_model_index: 42,
      },
    })
    expect(
      getChatState().messages.filter(
        (message) =>
          message.role === "user" && message.content === "Hello from the test",
      ),
    ).toHaveLength(1)
    expect(getChatState().isTyping).toBe(true)
    expect(getChatState().messages.at(-1)?.id).toBe(messageFrame.id)
  })

  it("rejects more than 16 attachments instead of silently truncating them", async () => {
    updateChatStore({ hasHydratedActiveSession: true })
    await connectChat()
    createdSockets[0].simulateOpen()
    const attachments = Array.from({ length: 17 }, (_, index) => ({
      type: "file" as const,
      url: `/file-${index}`,
    }))
    expect(await sendChatMessage({ content: "Files", attachments })).toBe(false)
    expect(
      createdSockets[0].sentData
        .map((data) => JSON.parse(data))
        .some(
          (frame) =>
            frame.type === "message.send" && frame.payload?.content === "Files",
        ),
    ).toBe(false)
    expect(
      getChatState().messages.some((message) => message.content === "Files"),
    ).toBe(false)
  })
  it("queues a retry while disconnected and safely replays the same request after reconnect", async () => {
    updateChatStore({
      hasHydratedActiveSession: true,
      messages: [
        { id: "failed-prompt", role: "user", content: "Run my saved task", timestamp: 1, deliveryStatus: "failed" },
        { id: "failed-error", role: "assistant", content: "The run failed.", kind: "error", timestamp: 2 },
      ],
    });

    expect(await retryChatMessage("failed-prompt")).toBe(true);
    expect(createdSockets).toHaveLength(1);
    expect(getChatState().messages[0]).toMatchObject({ deliveryStatus: "retrying" });
    expect(createdSockets[0].sentData.map((data) => JSON.parse(data)).some((frame) => frame.type === "message.retry")).toBe(false);

    createdSockets[0].simulateOpen();
    const firstFrame = createdSockets[0].sentData.map((data) => JSON.parse(data)).find((frame) => frame.type === "message.retry");
    expect(firstFrame).toMatchObject({ type: "message.retry", payload: { message_id: "failed-prompt", prompt_message_id: "failed-prompt", content: "Run my saved task" } });
    expect(firstFrame.id).not.toBe("failed-prompt");

    createdSockets[0].close();
    await connectChat();
    expect(createdSockets).toHaveLength(2);
    createdSockets[1].simulateOpen();
    const replayedFrame = createdSockets[1].sentData.map((data) => JSON.parse(data)).find((frame) => frame.type === "message.retry");
    expect(replayedFrame.id).toBe(firstFrame.id);

    createdSockets[1].simulateMessage({
      type: "message.accepted",
      session_id: "session-1",
      payload: { message_id: "failed-prompt", client_message_id: firstFrame.id, status: "processing", retry: true },
    });
  });

  it("retries with the original prompt attachments", async () => {
    updateChatStore({
      hasHydratedActiveSession: true,
      messages: [
        {
          id: "user-prompt",
          role: "user",
          content: "Inspect this file",
          timestamp: 1,
          attachments: [
            {
              type: "file",
              url: "/miki/media/report.pdf",
              filename: "report.pdf",
              contentType: "application/pdf",
            },
          ],
        },
        {
          id: "assistant-failed",
          role: "assistant",
          content: "The run failed.",
          kind: "error",
          timestamp: 2,
        },
      ],
    })
    await connectChat()
    createdSockets[0].simulateOpen()

    expect(await retryChatMessage("assistant-failed")).toBe(true)

    const retryFrame = createdSockets[0].sentData
      .map((data) => JSON.parse(data))
      .find((frame) => frame.type === "message.retry")
    expect(retryFrame).toMatchObject({
      payload: {
        message_id: "assistant-failed",
        prompt_message_id: "user-prompt",
        content: "Inspect this file",
        attachments: [
          {
            type: "file",
            url: "/miki/media/report.pdf",
            filename: "report.pdf",
            content_type: "application/pdf",
          },
        ],
      },
    })
    createdSockets[0].simulateMessage({
      type: "message.accepted",
      session_id: "session-1",
      payload: { message_id: "user-prompt", client_message_id: retryFrame.id, status: "processing", retry: true },
    })
  })

  it("keeps the canonical single session when a legacy switch is requested", async () => {
    const store = getDefaultStore()
    store.set(gatewayAtom, {
      status: "stopped",
      canStart: true,
      restartRequired: false,
      pendingRestartFields: [],
    })
    updateChatStore({
      activeRunId: "run-old",
      runningRunIds: ["run-old"],
      recentRunIds: ["run-old"],
      activeRunModel: "provider/old-model",
      activeRunProvider: "provider",
      runStatus: "running",
      runError: "old failure",
      deliveryOutcome: {
        runId: "run-old",
        status: "failed",
        artifactRefs: [],
        warnings: [],
        correlationId: "run-old",
      },
      isTyping: true,
    })

    await switchChatSession("session-next")

    expect(getChatState()).toMatchObject({
      activeSessionId: "session-1",
      isTyping: true,
      activeRunId: "run-old",
      runningRunIds: ["run-old"],
    })
    await switchChatSession("session-1")
  })

  it("clears the completed run from state when a terminal stream_done arrives", async () => {
    updateChatStore({ hasHydratedActiveSession: true })
    await connectChat()
    createdSockets[0].simulateOpen()
    updateChatStore({
      activeRunId: "run-cancelled",
      runningRunIds: ["run-cancelled"],
      runStatus: "running",
      isTyping: true,
    })

    createdSockets[0].simulateMessage({
      type: "stream_done",
      session_id: getChatState().activeSessionId,
      payload: { run_id: "run-cancelled", status: "cancelled" },
    })

    expect(getChatState()).toMatchObject({
      runningRunIds: [],
      isTyping: false,
      runStatus: "cancelled",
    })
  })

  it("keeps a message with uncertain status when socket.send throws", async () => {
    updateChatStore({ hasHydratedActiveSession: true })
    await connectChat()
    createdSockets[0].simulateOpen()
    createdSockets[0].send = () => {
      throw new Error("socket unavailable")
    }

    const sent = await sendChatMessage({ content: "This should roll back" })

    expect(sent).toBe(true)
    expect(getChatState().messages).toContainEqual(
      expect.objectContaining({
        content: "This should roll back",
        deliveryStatus: "uncertain",
      }),
    )
  })
})
