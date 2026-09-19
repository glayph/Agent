import { createFileRoute } from "@tanstack/react-router"

import { AutomationsPage } from "@/features/agent/automations/automations-page"

export const Route = createFileRoute("/agent/automations/list")({
  validateSearch: (search) => ({
    automationId:
      typeof search.automationId === "string" ? search.automationId : undefined,
  }),
  component: AutomationsListRoute,
})

function AutomationsListRoute() {
  return <AutomationsPage />
}
