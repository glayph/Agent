import { beforeEach, describe, expect, it, vi } from "vitest"

import { getGatewayLogs } from "./gateway"
import { launcherFetch } from "./http"

vi.mock("./http", () => ({
  launcherFetch: vi.fn(),
}))

describe("gateway API contract", () => {
  beforeEach(() => vi.clearAllMocks())

  it("sends canonical offset and run_id log parameters", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(
      new Response(JSON.stringify({ logs: ["line"], log_total: 3, log_run_id: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    await getGatewayLogs({ offset: 2, run_id: 42 })

    expect(launcherFetch).toHaveBeenCalledWith(
      "/api/gateway/logs?offset=2&run_id=42",
      undefined,
    )
  })
})
