import { createFileRoute } from "@tanstack/react-router"

import { AgentsIndexPage } from "@/pages/agents-index-page"

export const Route = createFileRoute("/agents/")({
  component: AgentsIndexPage,
})
