import { getDefaultStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { getChatState, updateChatStore } from "@/store/chat"
import { gatewayAtom } from "@/store/gateway"

import {
  connectChat,
  disconnectChat,
  editChatMessage,
  isPlatformConnectionIntent,
  sendChatMessage,
  setWebSocketFactory,
} from "./controller"

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
}

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

describe("chat controller platform intent detection", () => {
  it("keeps informational token questions in Chat", () => {
    expect(isPlatformConnectionIntent("What is a Telegram bot token?")).toBe(
      false,
    )
    expect(isPlatformConnectionIntent("টেলিগ্রাম বট টোকেন কী? ")).toBe(false)
    expect(isPlatformConnectionIntent("Explain API keys in simple terms")).toBe(
      false,
    )
  })

  it("recognizes explicit connection and setup requests", () => {
    expect(isPlatformConnectionIntent("Connect my Telegram account")).toBe(true)
    expect(
      isPlatformConnectionIntent("Configure the YouTube integration"),
    ).toBe(true)
    expect(isPlatformConnectionIntent("OAuth setup for Instagram")).toBe(true)
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

    const sent = await sendChatMessage({ content: "  Hello from the test  " })

    expect(sent).toBe(true)
    expect(createdSockets[0].sentData).toHaveLength(1)
    expect(JSON.parse(createdSockets[0].sentData[0])).toMatchObject({
      type: "message.send",
      payload: { content: "Hello from the test", media: [] },
    })
    expect(
      getChatState().messages.filter(
        (message) =>
          message.role === "user" && message.content === "Hello from the test",
      ),
    ).toHaveLength(1)
    expect(getChatState().isTyping).toBe(true)
  })

  it("rolls back the optimistic message when socket.send throws", async () => {
    updateChatStore({ hasHydratedActiveSession: true })
    await connectChat()
    createdSockets[0].simulateOpen()
    createdSockets[0].send = () => {
      throw new Error("socket unavailable")
    }

    const sent = await sendChatMessage({ content: "This should roll back" })

    expect(sent).toBe(false)
    expect(
      getChatState().messages.some(
        (message) => message.content === "This should roll back",
      ),
    ).toBe(false)
    expect(getChatState().isTyping).toBe(false)
  })
})
