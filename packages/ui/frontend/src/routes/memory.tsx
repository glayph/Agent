import { createFileRoute } from "@tanstack/react-router"

import { MemoryPage } from "@/pages/memory-page"

export const Route = createFileRoute("/memory")({
  component: MemoryPage,
})
