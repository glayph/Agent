import { createFileRoute } from "@tanstack/react-router"

import { PluginsPage } from "@/features/plugins/plugins-page"

export const Route = createFileRoute("/plugins/health")({
  component: PluginHealthRoute,
})

function PluginHealthRoute() {
  return <PluginsPage section="health" />
}
