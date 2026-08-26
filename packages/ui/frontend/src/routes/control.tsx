import { createFileRoute } from "@tanstack/react-router"

import { ControlPage } from "@/pages/control-page"

export const Route = createFileRoute("/control")({
  component: ControlPage,
})
