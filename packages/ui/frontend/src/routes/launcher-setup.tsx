import { createFileRoute } from "@tanstack/react-router"

import { LauncherSetupPage } from "@/pages/launcher-setup-page"

export const Route = createFileRoute("/launcher-setup")({
  component: LauncherSetupPage,
})
