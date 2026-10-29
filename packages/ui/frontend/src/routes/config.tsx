import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router"

import { ConfigPage } from "@/pages/config-page"

export const Route = createFileRoute("/config")({
  validateSearch: (search: Record<string, unknown>) => ({
    view: search.view === "raw" ? "raw" as const : undefined,
  }),
  component: ConfigLayout,
})

function ConfigLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  if (pathname === "/config") {
    return <ConfigPage />
  }

  return <Outlet />
}
