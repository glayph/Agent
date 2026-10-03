import { createFileRoute } from "@tanstack/react-router"

import { PluginsPage } from "@/features/plugins/plugins-page"

export const Route = createFileRoute("/plugins/capabilities")({
  component: CapabilitiesPluginsRoute,
})

function CapabilitiesPluginsRoute() {
  return <PluginsPage section="capability" />
}
