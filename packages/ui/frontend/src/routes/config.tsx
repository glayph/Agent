import { createFileRoute } from "@tanstack/react-router"

import { ConfigPage } from "@/pages/config-page"

export const Route = createFileRoute("/config")({
  component: ConfigPage,
})
