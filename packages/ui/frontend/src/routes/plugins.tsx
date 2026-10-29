import { createFileRoute } from "@tanstack/react-router"

import { PluginsPage } from "@/features/plugins/plugins-page"

export const Route = createFileRoute("/plugins")({
  validateSearch: (search: Record<string, unknown>) => ({
    section: search.section === "core" || search.section === "health" || search.section === "catalog"
      ? search.section
      : "catalog",
  }),
  component: PluginsPage,
})
