import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  connectChat,
  editChatMessage,
  setWebSocketFactory,
} from "./controller"
import { getChatState, updateChatStore } from "@/store/chat"
import { gatewayAtom } from "@/store/gateway"
import { getDefaultStore } from "jotai"

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}))

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

describe("chat controller WebSocket dependency injection", () => {
  let createdSockets: MockWebSocket[] = []

  beforeEach(() => {
    resetChatState()
    createdSockets = []
    const store = getDefaultStore()
    store.set(gatewayAtom, { status: "running", canStart: true, restartRequired: false, pendingRestartFields: [] })

    setWebSocketFactory((url: string) => {
      const mock = new MockWebSocket(url)
      createdSockets.push(mock)
      return mock as unknown as WebSocket
    })
  })

  afterEach(() => {
    setWebSocketFactory(null)
  })

  it("connects to WebSocket endpoint with session_id parameter and updates connectionState", async () => {
    updateChatStore({ hasHydratedActiveSession: true })
    await connectChat()

    expect(createdSockets).toHaveLength(1)
    expect(createdSockets[0].url).toContain("/pico/ws?session_id=")
    expect(getChatState().connectionState).toBe("connecting")

    createdSockets[0].simulateOpen()
    expect(getChatState().connectionState).toBe("connected")
  })
})
