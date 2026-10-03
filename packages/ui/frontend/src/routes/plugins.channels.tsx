import { createFileRoute } from "@tanstack/react-router"

import { PluginsPage } from "@/features/plugins/plugins-page"

export const Route = createFileRoute("/plugins/channels")({
  component: ChannelsPluginsRoute,
})

function ChannelsPluginsRoute() {
  return <PluginsPage section="channel" />
}
