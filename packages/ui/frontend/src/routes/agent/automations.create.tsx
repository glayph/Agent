import { createFileRoute } from "@tanstack/react-router"

import { AutomationCreatePage } from "@/features/agent/automations/automation-create-page"

export const Route = createFileRoute("/agent/automations/create")({
  validateSearch: (search) => ({
    automationId:
      typeof search.automationId === "string" ? search.automationId : undefined,
  }),
  component: AutomationCreateRoute,
})

function AutomationCreateRoute() {
  return <AutomationCreatePage />
}
