import { afterEach, describe, expect, it, vi } from "vitest"

import { launcherFetch } from "@/api/http"
import {
  cancelActiveTask,
  createEventTrigger,
  getBackgroundJob,
  getScheduledTasks,
  reconcileBackgroundJob,
  updateScheduledTask,
} from "./activity-api"

vi.mock("@/api/http", () => ({ launcherFetch: vi.fn() }))

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

describe("Activity API integration contracts", () => {
  afterEach(() => vi.clearAllMocks())

  it("requests scheduled tasks using bounded offset pagination", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(ok({ tasks: [] }))
    await getScheduledTasks(100, 200)
    expect(launcherFetch).toHaveBeenCalledWith("/api/autonomy/tasks?limit=100&offset=200", { showErrorToast: false })
  })

  it("creates event triggers with their event filter and acceptance contract", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(ok({ trigger: { trigger_id: 4 } }))
    await createEventTrigger({ event_name: "webhook:deploy", title: "Review deploy", filter: { branch: "main" }, acceptance: { mode: "all", checks: [] } })
    const [url, init] = vi.mocked(launcherFetch).mock.calls[0]
    expect(url).toBe("/api/autonomy/triggers")
    expect(JSON.parse(String(init?.body))).toMatchObject({ event_name: "webhook:deploy", filter: { branch: "main" } })
  })

  it("loads background job details and posts reconciliation evidence", async () => {
    vi.mocked(launcherFetch).mockResolvedValueOnce(ok({ job: { id: "job-1" }, tree: null, events: [] }))
    vi.mocked(launcherFetch).mockResolvedValueOnce(ok({ resumedTaskIds: [], tree: null, remainingUnsettledActions: [] }))
    await getBackgroundJob("job-1")
    await reconcileBackgroundJob("job-1", { evidence: { checked: true }, actions: [] })
    expect(vi.mocked(launcherFetch).mock.calls[0][0]).toBe("/api/background-jobs/job-1")
    expect(vi.mocked(launcherFetch).mock.calls[1][0]).toBe("/api/background-jobs/job-1/reconcile")
  })

  it("edits one-time and interval schedules through their schedule fields", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(ok({ task: {} }))
    await updateScheduledTask(9, { due_at: "2030-01-01T00:00:00.000Z", interval_seconds: 7200 })
    expect(JSON.parse(String(vi.mocked(launcherFetch).mock.calls[0][1]?.body))).toMatchObject({ due_at: "2030-01-01T00:00:00.000Z", interval_seconds: 7200 })
  })

  it("cancels a live agent run by its run identifier", async () => {
    vi.mocked(launcherFetch).mockResolvedValue(ok({ status: "cancelling", id: "run-7" }))
    await cancelActiveTask("run-7")
    expect(launcherFetch).toHaveBeenCalledWith("/api/tasks/run-7", { method: "DELETE", showErrorToast: false })
  })
})
