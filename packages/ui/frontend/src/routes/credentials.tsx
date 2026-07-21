import { createFileRoute } from "@tanstack/react-router"

import { CredentialsPage } from "@/pages/credentials-page"

export const Route = createFileRoute("/credentials")({
  component: CredentialsPage,
})
