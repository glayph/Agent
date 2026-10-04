import { useCallback, useEffect, useMemo, useState } from "react"
import { PageHeader } from "@/app/layout/page-header"
import { Button } from "@/shared/ui/button"
import { listRuns, type AgentRun } from "@/api/runs"
import type { AgentRunsSearchState } from "./runs-page-model"

interface RunsPageProps {
  search: AgentRunsSearchState
  onSearchChange: (patch: Partial<AgentRunsSearchState>) => void
}

function statusTone(status: string): string {
  switch (status) {
    case "completed":
      return "text-emerald-600"
    case "running":
      return "text-sky-600"
    case "failed":
    case "limit_reached":
      return "text-rose-600"
    case "cancelled":
      return "text-amber-600"
    default:
      return "text-muted-foreground"
  }
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function truncate(text: string | null | undefined, max = 120): string {
  if (!text) return "—"
  const t = text.replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

export function RunsPage({ search, onSearchChange }: RunsPageProps) {
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listRuns({
        q: search.q || search.query,
        status: search.status,
        page: search.page,
        limit: 25,
      })
      setRuns(data.runs)
      setTotal(data.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setRuns([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [search.q, search.query, search.status, search.page])

  useEffect(() => {
    void load()
  }, [load])

  const emptyMessage = useMemo(() => {
    if (loading) return "Loading runs…"
    if (error) return error
    if (search.q) return `No runs match “${search.q}”.`
    return "No agent runs yet. Chat with Miki or wait for an autonomy cycle."
  }, [loading, error, search.q])

  const totalPages = Math.max(1, Math.ceil(total / 25))

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Agent runs" />
      <main className="flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto w-full max-w-5xl space-y-6">
          <section className="rounded-xl border p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold">Agent run history</h1>
                <p className="text-muted-foreground mt-1 text-sm">
                  Completed and active Miki tasks across chat, heartbeat, and autonomy lanes.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
                Refresh
              </Button>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <input
                className="border-input bg-background h-9 min-w-64 rounded-md border px-3 text-sm"
                value={search.q}
                onChange={(event) =>
                  onSearchChange({ q: event.target.value, query: event.target.value, page: 1 })
                }
                placeholder="Search runs"
                aria-label="Search runs"
              />
              <select
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                value={search.status}
                onChange={(event) => onSearchChange({ status: event.target.value, page: 1 })}
                aria-label="Filter by status"
              >
                <option value="all">All statuses</option>
                <option value="running">Running</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
                <option value="limit_reached">Limit reached</option>
              </select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSearchChange({ query: "", q: "", status: "all", page: 1 })}
              >
                Clear filters
              </Button>
            </div>
          </section>

          {runs.length === 0 ? (
            <section
              className="text-muted-foreground rounded-xl border p-8 text-center text-sm"
              role="status"
            >
              {emptyMessage}
            </section>
          ) : (
            <section className="space-y-3" aria-label="Run list">
              <p className="text-muted-foreground text-xs">
                Showing {runs.length} of {total} run{total === 1 ? "" : "s"}
              </p>
              <ul className="space-y-2">
                {runs.map((run) => (
                  <li
                    key={run.id}
                    className="rounded-xl border px-4 py-3 text-sm transition-colors hover:bg-muted/40"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`font-medium capitalize ${statusTone(run.status)}`}>
                          {run.status}
                        </span>
                        <span className="text-muted-foreground rounded-md border px-1.5 py-0.5 text-xs uppercase tracking-wide">
                          {run.lane}
                        </span>
                        <span className="text-muted-foreground text-xs">{run.source}</span>
                      </div>
                      <span className="text-muted-foreground text-xs">
                        {formatWhen(run.started_at)}
                      </span>
                    </div>
                    <p className="mt-1 font-medium leading-snug">{truncate(run.goal, 160)}</p>
                    {run.error ? (
                      <p className="mt-1 text-xs text-rose-600">{truncate(run.error, 200)}</p>
                    ) : run.final_text ? (
                      <p className="text-muted-foreground mt-1 text-xs">
                        {truncate(run.final_text, 180)}
                      </p>
                    ) : null}
                    <div className="text-muted-foreground mt-2 flex flex-wrap gap-3 text-xs">
                      <span>id: {run.id.slice(0, 12)}…</span>
                      {run.model ? <span>model: {run.model}</span> : null}
                      <span>turns: {run.turns}</span>
                      <span>tools: {run.tool_calls}</span>
                      {run.usage?.total_tokens ? (
                        <span>tokens: {run.usage.total_tokens}</span>
                      ) : null}
                      {run.finished_at ? (
                        <span>finished: {formatWhen(run.finished_at)}</span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
              {totalPages > 1 ? (
                <div className="flex items-center justify-between pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={search.page <= 1 || loading}
                    onClick={() => onSearchChange({ page: Math.max(1, search.page - 1) })}
                  >
                    Previous
                  </Button>
                  <span className="text-muted-foreground text-xs">
                    Page {search.page} / {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={search.page >= totalPages || loading}
                    onClick={() => onSearchChange({ page: search.page + 1 })}
                  >
                    Next
                  </Button>
                </div>
              ) : null}
            </section>
          )}
        </div>
      </main>
    </div>
  )
}
