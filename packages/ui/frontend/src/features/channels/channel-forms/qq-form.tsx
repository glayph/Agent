import { useTranslation } from "react-i18next"

import type { ChannelConfig } from "@/api/channels"
import { getSecretInputPlaceholder } from "@/features/channels/components/channel-config-fields"
import {
  ChannelFieldCard,
  ChannelSection,
} from "@/features/channels/components/channel-section"
import { Field, KeyInput } from "@/shared/forms/shared-form"
import { Input } from "@/shared/ui/input"

interface QQFormProps {
  config: ChannelConfig
  onChange: (key: string, value: unknown) => void
  configuredSecrets: string[]
  fieldErrors?: Record<string, string>
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function QQForm({
  config,
  onChange,
  configuredSecrets,
  fieldErrors = {},
}: QQFormProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <ChannelSection
        title={t("channels.section.credentials")}
        description={t("channels.section.credentialsDesc")}
      >
        <ChannelFieldCard>
          <Field
            label="Bot ID"
            required
            hint="QQ Bot ID"
            error={fieldErrors.bot_id}
          >
            <Input
              value={asString(config.bot_id)}
              onChange={(e) => onChange("bot_id", e.target.value)}
              placeholder="1234567890"
            />
          </Field>

          <Field
            label="Bot Token"
            required
            hint="QQ Bot token"
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
        </ChannelFieldCard>
      </ChannelSection>
    </div>
  )
}
