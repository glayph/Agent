import { createFileRoute } from "@tanstack/react-router"

import { MonitorCanvas } from "@/features/monitor/monitor-canvas"

export const Route = createFileRoute("/agent/monitor")({
  component: AgentMonitorRoute,
})

function AgentMonitorRoute() {
  return <MonitorCanvas />
}
