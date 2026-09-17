import { createFileRoute } from "@tanstack/react-router"

import { AgentDetailPage } from "@/pages/agent-detail-page"

export const Route = createFileRoute("/agents/$id")({
  component: AgentDetailRoute,
})

function AgentDetailRoute() {
  const { id } = Route.useParams()
  return <AgentDetailPage id={id} />
}
