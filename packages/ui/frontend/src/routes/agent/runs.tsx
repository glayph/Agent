import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useCallback } from "react"

import { RunsPage } from "@/components/agent/runs/runs-page"
import {
  type AgentRunsSearchState,
  normalizeAgentRunsSearch,
} from "@/components/agent/runs/runs-page-model"

export const Route = createFileRoute("/agent/runs")({
  validateSearch: (search) => normalizeAgentRunsSearch(search),
  component: AgentRunsRoute,
})

function AgentRunsRoute() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: "/agent/runs" })
  const handleSearchChange = useCallback(
    (patch: Partial<AgentRunsSearchState>) => {
      void navigate({
        search: (current) =>
          normalizeAgentRunsSearch({
            ...current,
            ...patch,
          }),
        replace: true,
        resetScroll: false,
      })
    },
    [navigate],
  )

  return <RunsPage search={search} onSearchChange={handleSearchChange} />
}
