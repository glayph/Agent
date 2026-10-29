import { createFileRoute } from "@tanstack/react-router"

import { SkillsPage } from "@/features/agent/skills/skills-page"

export const Route = createFileRoute("/agent/skills")({
  validateSearch: (search: Record<string, unknown>) => ({
    view: search.view === "discover" ? "discover" as const : undefined,
  }),
  component: AgentSkillsRoute,
})

function AgentSkillsRoute() {
  return <SkillsPage />
}
