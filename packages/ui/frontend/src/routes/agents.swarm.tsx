import { createFileRoute } from "@tanstack/react-router"

import { AgentSwarmPage } from "@/pages/agent-swarm-page"

export const Route = createFileRoute("/agents/swarm")({
  component: AgentSwarmPage,
})
