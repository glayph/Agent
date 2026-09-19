import { createFileRoute } from "@tanstack/react-router"

import { LauncherLoginPage } from "@/pages/launcher-login-page"

export const Route = createFileRoute("/launcher-login")({
  component: LauncherLoginPage,
})
