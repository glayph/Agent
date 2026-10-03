import { createFileRoute } from "@tanstack/react-router"

import { PluginsPage } from "@/features/plugins/plugins-page"

export const Route = createFileRoute("/plugins/core")({
  component: CorePluginsRoute,
})

function CorePluginsRoute() {
  return <PluginsPage section="core" />
}
