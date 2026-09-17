import { createFileRoute } from "@tanstack/react-router"

import { RawConfigPage } from "@/features/config/components/raw-config-page"

export const Route = createFileRoute("/config/raw")({
  component: RawConfigPage,
})
