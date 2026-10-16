import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router"

import { ChannelCatalogPage } from "@/pages/channels-page"

export const Route = createFileRoute("/channels")({
  component: ChannelsLayout,
})

function ChannelsLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  if (pathname === "/channels") {
    return <ChannelCatalogPage />
  }

  return <Outlet />
}
