import { createFileRoute } from "@tanstack/react-router"

import { PluginsPage } from "@/features/plugins/plugins-page"

export const Route = createFileRoute("/plugins/providers")({
  component: ProvidersPluginsRoute,
})

function ProvidersPluginsRoute() {
  return <PluginsPage section="provider" />
}
