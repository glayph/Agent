import { createFileRoute } from "@tanstack/react-router"

import { ModelsPage } from "@/pages/models-page"

export const Route = createFileRoute("/models")({
  component: ModelsPage,
})
