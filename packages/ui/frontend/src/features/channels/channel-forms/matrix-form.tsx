import { useTranslation } from "react-i18next"

import type { ChannelConfig } from "@/api/channels"
import { getSecretInputPlaceholder } from "@/features/channels/components/channel-config-fields"
import { Field, KeyInput } from "@/shared/forms/shared-form"
import { Card, CardContent } from "@/shared/ui/card"
import { Input } from "@/shared/ui/input"

interface MatrixFormProps {
  config: ChannelConfig
  onChange: (key: string, value: unknown) => void
  configuredSecrets: string[]
  fieldErrors?: Record<string, string>
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function MatrixForm({
  config,
  onChange,
  configuredSecrets,
  fieldErrors = {},
}: MatrixFormProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <Card className="shadow-sm">
        <CardContent className="divide-border/60 divide-y px-6 py-0 [&>div]:py-5">
          <Field
            label="Homeserver URL"
            required
            hint="Matrix homeserver URL"
            error={fieldErrors.homeserver_url}
          >
            <Input
              value={asString(config.homeserver_url)}
              onChange={(e) => onChange("homeserver_url", e.target.value)}
              placeholder="https://matrix.org"
            />
          </Field>

          <Field label="User ID" required hint="Matrix user ID" error={fieldErrors.user_id}>
            <Input
              value={asString(config.user_id)}
              onChange={(e) => onChange("user_id", e.target.value)}
              placeholder="@user:matrix.org"
            />
          </Field>

          <Field
            label="Access Token"
            required
            hint="Matrix access token"
            error={fieldErrors.access_token}
          >
            <KeyInput
              value={asString(config._access_token)}
              onChange={(v) => onChange("_access_token", v)}
              placeholder={getSecretInputPlaceholder(
                configuredSecrets,
                "access_token",
                t("channels.field.secretHintSet"),
                "****************",
              )}
            />
          </Field>
        </CardContent>
      </Card>
    </div>
  )
}
