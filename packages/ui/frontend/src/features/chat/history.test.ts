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

  it("hides only explicitly classified progress and warning notices", async () => {
    getSessionHistoryMock.mockResolvedValue({
      id: "session-1",
      summary: "",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      messages: [
        { id: "user-1", role: "user", content: "Quota limits are useful to track." },
        { id: "proactive-1", role: "assistant", content: "Background progress.", context_id: "proactive:progress:run-1", notification_kind: "progress" },
        { id: "proactive-warning", role: "assistant", content: "A background task failed.", context_id: "proactive:warning:run-1", notification_kind: "warning" },
        { id: "proactive-result", role: "assistant", content: "A background task completed.", context_id: "proactive:result:run-2", notification_kind: "result" },
        { id: "quota-log", role: "assistant", content: "Quota limit reached.", kind: "error" },
        { id: "provider-log", role: "assistant", content: "[ProviderPlugin] provider.plugin.ready" },
      ],
    })

    const messages = await loadSessionMessages("session-1")

    expect(messages.map((message) => message.id)).toEqual([
      "user-1",
      "proactive-result",
      "quota-log",
      "provider-log",
    ])
  })
})
