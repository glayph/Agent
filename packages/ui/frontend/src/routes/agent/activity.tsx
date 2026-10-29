import { createFileRoute } from "@tanstack/react-router"

import { ActivityView } from "@/features/activity/activity-view"

export const Route = createFileRoute("/agent/activity")({
  component: AgentActivityRoute,
})

function AgentActivityRoute() {
  return <ActivityView />
}
