import { createFileRoute } from "@tanstack/react-router"

import { ChannelsPage } from "@/pages/channels-page"

export const Route = createFileRoute("/channels/$name")({
  component: ChannelsByNameRoute,
})

function ChannelsByNameRoute() {
  const { name } = Route.useParams()

  return <ChannelsPage channelName={name} />
}
