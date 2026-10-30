import { launcherFetch } from "@/api/http"

export interface ServerMonitorSnapshot {
  runs: Array<{ id: string; status: "running" | "completed" | "failed"; startedAt: number; endedAt?: number; planTotal?: number; planLevels?: number; lastSeq?: number }>
  nodes: Array<{ id: string; runId: string; type: string; label: string; status: string; level: number; parallel: boolean; attempt?: number; durationMs?: number; createdAt: number; updatedAt: number; uiState?: "minimized" | "expanded" }>
  edges: Array<{ id: string; runId: string; source: string; target: string; animated: boolean }>
  high_water_seq: number
  next_before_seq: number | null
  next_before: { seq: number; started_at: string; run_id: string } | null
  fetched_at: string
}

export type MonitorHistoryCursor = NonNullable<ServerMonitorSnapshot["next_before"]>

export async function fetchMonitorHistory(before?: MonitorHistoryCursor): Promise<ServerMonitorSnapshot> {
  const query = new URLSearchParams({ limit: "12" })
  if (before) {
    query.set("before_seq", String(before.seq))
    query.set("before_started_at", before.started_at)
    query.set("before_run_id", before.run_id)
  }
  const response = await launcherFetch(`/api/monitor/history?${query.toString()}`, { showErrorToast: false })
  if (!response.ok) throw new Error(`monitor_history_http_${response.status}`)
  return response.json() as Promise<ServerMonitorSnapshot>
}

export async function importLocalMonitorHistory(history: unknown, importId: string): Promise<void> {
  const response = await launcherFetch("/api/monitor/history/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ import_id: importId, session_id: "legacy-local-import", history }),
    showErrorToast: false,
  })
  if (!response.ok) throw new Error(`monitor_history_import_http_${response.status}`)
}
