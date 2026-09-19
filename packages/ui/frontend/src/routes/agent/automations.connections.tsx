import { createFileRoute } from "@tanstack/react-router"

import { PlatformConnectionsPage } from "@/features/agent/automations/platform-connections-page"

export const Route = createFileRoute("/agent/automations/connections")({
  component: PlatformConnectionsRoute,
})

function PlatformConnectionsRoute() {
  return <PlatformConnectionsPage />
}
