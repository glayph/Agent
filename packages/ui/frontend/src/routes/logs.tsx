import { createFileRoute } from "@tanstack/react-router"

import { LogsPage } from "@/pages/logs-page"

export const Route = createFileRoute("/logs")({
  component: LogsPage,
})
