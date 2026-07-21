import { createFileRoute } from "@tanstack/react-router"

import { HealthPage } from "@/pages/health-page"

export const Route = createFileRoute("/health")({
  component: HealthPage,
})
