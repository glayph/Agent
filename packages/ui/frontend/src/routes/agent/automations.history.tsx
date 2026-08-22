import { createFileRoute } from "@tanstack/react-router"

import { AutomationHistoryPage } from "@/features/agent/automations/automation-history-page"

export const Route = createFileRoute("/agent/automations/history")({
  validateSearch: (search) => ({
    automationId:
      typeof search.automationId === "string" ? search.automationId : undefined,
  }),
  component: AutomationHistoryRoute,
})

function AutomationHistoryRoute() {
  return <AutomationHistoryPage />
}
