import { IconExternalLink } from "@tabler/icons-react"
import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"

import { PageHeader } from "@/app/layout/page-header"
import { CredentialCard } from "@/features/credentials/components/credential-card"
import { Button } from "@/shared/ui/button"

export const Route = createFileRoute("/credentials")({
  component: CredentialsPage,
})

function CredentialsPage() {
  const { t } = useTranslation()

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("navigation.credentials")} titleLevel={1} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto w-full max-w-4xl space-y-4 py-4">
          <p className="text-muted-foreground text-sm">
            Agent Miki supports only two AI providers: Google Gemini and local
            llama.cpp. Configure the Gemini API key or llama.cpp model from the
            Models page. Secrets are stored through the protected credential
            flow and are never sent to the model as plain chat content.
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            <CredentialCard
              title="Google Gemini"
              description="Cloud Gemini plugin. Requires a Gemini API key."
              status="not_logged_in"
              details="Model discovery and completion readiness are checked from Models."
              actions={
                <Button
                  className="w-full"
                  onClick={() => {
                    window.location.href = "/models"
                  }}
                >
                  Configure Gemini
                  <IconExternalLink className="ml-2 size-4" aria-hidden="true" />
                </Button>
              }
            />
            <CredentialCard
              title="llama.cpp Local"
              description="Local plugin. No cloud API key is required."
              status="not_logged_in"
              details="Configure a supported GGUF model and local llama-server from Models."
              actions={
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={() => {
                    window.location.href = "/models"
                  }}
                >
                  Configure llama.cpp
                  <IconExternalLink className="ml-2 size-4" aria-hidden="true" />
                </Button>
              }
            />
          </div>
        </div>
      </div>
    </div>
  )
}
