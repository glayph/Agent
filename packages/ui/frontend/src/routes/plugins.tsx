import { Outlet, createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/plugins")({
  component: PluginsLayoutRoute,
})

function PluginsLayoutRoute() {
  return <Outlet />
}
