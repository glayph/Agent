import { createFileRoute } from "@tanstack/react-router"

import { PluginsPage } from "@/features/plugins/plugins-page"

export const Route = createFileRoute("/plugins/catalog")({
  component: PluginCatalogRoute,
})

function PluginCatalogRoute() {
  return <PluginsPage section="catalog" />
}
