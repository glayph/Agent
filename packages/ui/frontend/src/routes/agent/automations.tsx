import { Outlet, createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/agent/automations")({
  component: AutomationCenterLayout,
})

function AutomationCenterLayout() {
  return <Outlet />
}
