import { afterEach, describe, expect, it, vi } from "vitest"

import { launcherFetch } from "@/api/http"
import { fetchMonitorHistory } from "./history-api"

vi.mock("@/api/http", () => ({ launcherFetch: vi.fn() }))

describe("Monitor history API pagination", () => {
  afterEach(() => vi.clearAllMocks())

  it("requests the first page and preserves the server continuation cursor", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(new Response(JSON.stringify({ runs: [], nodes: [], edges: [], high_water_seq: 22, next_before_seq: 15, next_before: { seq: 15, started_at: "2026-10-30T00:00:00.000Z", run_id: "run-15" }, fetched_at: "2026-10-30T00:00:00.000Z" }), { status: 200 }))
    const result = await fetchMonitorHistory()
    expect(launcherFetch).toHaveBeenCalledWith("/api/monitor/history?limit=12", { showErrorToast: false })
    expect(result.next_before_seq).toBe(15)
    expect(result.next_before?.run_id).toBe("run-15")
    expect(result.high_water_seq).toBe(22)
  })

  it("uses a stable compound cursor when loading older history", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(new Response(JSON.stringify({ runs: [], nodes: [], edges: [], high_water_seq: 22, next_before_seq: null, next_before: null, fetched_at: "2026-10-30T00:00:00.000Z" }), { status: 200 }))
    const result = await fetchMonitorHistory({ seq: 0, started_at: "2026-10-30T00:00:00.000Z", run_id: "legacy-run" })
    expect(launcherFetch).toHaveBeenCalledWith("/api/monitor/history?limit=12&before_seq=0&before_started_at=2026-10-30T00%3A00%3A00.000Z&before_run_id=legacy-run", { showErrorToast: false })
    expect(result.next_before).toBeNull()
  })

  it("surfaces unavailable history instead of erasing the local fallback", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(new Response("{}", { status: 503 }))
    await expect(fetchMonitorHistory()).rejects.toThrow("monitor_history_http_503")
  })
})
