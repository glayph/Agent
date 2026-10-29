import { beforeEach, describe, expect, it, vi } from "vitest"

import { getSessionHistory } from "@/api/sessions"
import { loadSessionMessages } from "./history"

vi.mock("@/api/sessions", () => ({
  getSessionHistory: vi.fn(),
}))

const getSessionHistoryMock = vi.mocked(getSessionHistory)

describe("chat history log filtering", () => {
  beforeEach(() => {
    getSessionHistoryMock.mockReset()
  })

  it("hides stored system logs but keeps user and proactive assistant messages", async () => {
    getSessionHistoryMock.mockResolvedValue({
      id: "session-1",
      summary: "",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      messages: [
        { id: "user-1", role: "user", content: "Quota limits are useful to track." },
        { id: "proactive-1", role: "assistant", content: "I found a useful update for you." },
        { id: "quota-log", role: "assistant", content: "Quota limit reached.", kind: "error" },
        { id: "provider-log", role: "assistant", content: "[ProviderPlugin] provider.plugin.ready" },
      ],
    })

    const messages = await loadSessionMessages("session-1")

    expect(messages.map((message) => message.id)).toEqual([
      "user-1",
      "proactive-1",
    ])
  })
})
