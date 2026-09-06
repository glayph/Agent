import { useTranslation } from "react-i18next"

import type { ChannelConfig } from "@/api/channels"
import { getSecretInputPlaceholder } from "@/features/channels/components/channel-config-fields"
import { Field, KeyInput } from "@/shared/forms/shared-form"
import { Card, CardContent } from "@/shared/ui/card"

interface DingTalkFormProps {
  config: ChannelConfig
  onChange: (key: string, value: unknown) => void
  configuredSecrets: string[]
  fieldErrors?: Record<string, string>
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function DingTalkForm({
  config,
  onChange,
  configuredSecrets,
  fieldErrors = {},
}: DingTalkFormProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <Card className="shadow-sm">
        <CardContent className="divide-border/60 divide-y px-6 py-0 [&>div]:py-5">
          <Field
            label="Webhook URL"
            required
            hint="DingTalk robot webhook URL"
            error={fieldErrors.webhook_url}
          >
            <KeyInput
              value={asString(config._webhook_url)}
              onChange={(value) => onChange("_webhook_url", value)}
              placeholder={getSecretInputPlaceholder(
                configuredSecrets,
                "webhook_url",
                t("channels.field.secretHintSet"),
                "https://oapi.dingtalk.com/robot/send?access_token=...",
              )}
            />
          </Field>

          <Field
            label="Client Secret"
            hint="DingTalk app secret"
            error={fieldErrors.client_secret}
          >
            <KeyInput
              value={asString(config._client_secret)}
              onChange={(value) => onChange("_client_secret", value)}
              placeholder={getSecretInputPlaceholder(
                configuredSecrets,
                "client_secret",
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
