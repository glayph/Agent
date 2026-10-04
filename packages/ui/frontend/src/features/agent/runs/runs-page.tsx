import { useMemo } from "react"
import { PageHeader } from "@/app/layout/page-header"
import { Button } from "@/shared/ui/button"
import type { AgentRunsSearchState } from "./runs-page-model"

interface RunsPageProps {
  search: AgentRunsSearchState
  onSearchChange: (patch: Partial<AgentRunsSearchState>) => void
}

export function RunsPage({ search, onSearchChange }: RunsPageProps) {
  const emptyMessage = useMemo(
    () => (search.q ? `No runs match “${search.q}”.` : "No agent runs yet."),
    [search.q],
  )
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Agent runs" />
      <main className="flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto w-full max-w-5xl space-y-6">
          <section className="rounded-xl border p-5">
            <h1 className="text-xl font-semibold">Agent run history</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Review completed and active Miki tasks from this workspace.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <input
                className="border-input bg-background h-9 min-w-64 rounded-md border px-3 text-sm"
                value={search.q}
                onChange={(event) => onSearchChange({ q: event.target.value, query: event.target.value, page: 1 })}
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
              </select>
              <Button variant="outline" size="sm" onClick={() => onSearchChange({ query: "", status: "all", page: 1 })}>
                Clear filters
              </Button>
            </div>
          </section>
          <section className="text-muted-foreground rounded-xl border p-8 text-center text-sm" role="status">
            {emptyMessage}
          </section>
        </div>
      </main>
    </div>
  )
}
