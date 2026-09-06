import { createFileRoute } from "@tanstack/react-router"

import { AutomationOverviewPage } from "@/features/agent/automations/automation-overview-page"

export const Route = createFileRoute("/agent/automations/")({
  component: AutomationOverviewPage,
})
