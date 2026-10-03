import { createFileRoute } from "@tanstack/react-router"

import { PluginHomePage } from "@/features/plugins/plugins-page"

export const Route = createFileRoute("/plugins/")({
  component: PluginsIndexRoute,
})

function PluginsIndexRoute() {
  return <PluginHomePage />
}
