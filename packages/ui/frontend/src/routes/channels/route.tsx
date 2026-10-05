import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router"

import { ChannelsPage } from "@/pages/channels-page"

export const Route = createFileRoute("/channels")({
  component: ChannelsLayout,
})

function ChannelsLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  if (pathname === "/channels") {
    return <ChannelsPage channelName="miki" />
  }

  return <Outlet />
}
