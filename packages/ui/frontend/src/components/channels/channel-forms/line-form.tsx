import { useTranslation } from "react-i18next"

import type { ChannelConfig } from "@/api/channels"
import { getSecretInputPlaceholder } from "@/components/channels/channel-config-fields"
import { Field, KeyInput } from "@/components/shared-form"
import { Card, CardContent } from "@/components/ui/card"

interface LineFormProps {
  config: ChannelConfig
  onChange: (key: string, value: unknown) => void
  configuredSecrets: string[]
  fieldErrors?: Record<string, string>
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function LineForm({
  config,
  onChange,
  configuredSecrets,
  fieldErrors = {},
}: LineFormProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <Card className="shadow-sm">
        <CardContent className="divide-border/60 divide-y px-6 py-0 [&>div]:py-5">
          <Field
            label={t("channels.field.token")}
            required
            hint="LINE Bot token"
            error={fieldErrors.token}
          >
            <KeyInput
              value={asString(config._token)}
              onChange={(v) => onChange("_token", v)}
              placeholder={getSecretInputPlaceholder(
                configuredSecrets,
                "token",
                t("channels.field.secretHintSet"),
                "****************",
              )}
            />
          </Field>

          <Field
            label={t("channels.field.channelSecret")}
            required
            hint="LINE channel secret used to verify webhook signatures"
            error={fieldErrors.channel_secret}
          >
            <KeyInput
              value={asString(config._channel_secret)}
              onChange={(v) => onChange("_channel_secret", v)}
              placeholder={getSecretInputPlaceholder(
                configuredSecrets,
                "channel_secret",
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
