import { useTranslation } from "react-i18next"

import type { ChannelConfig } from "@/api/channels"
import {
  type ArrayFieldFlusher,
  ChannelArrayListField,
} from "@/components/channels/channel-array-list-field"
import {
  asStringArray,
  parseAllowFromInput,
} from "@/components/channels/channel-array-utils"
import { getSecretInputPlaceholder } from "@/components/channels/channel-config-fields"
import { Field, KeyInput } from "@/components/shared-form"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

import { QrBindingPanel } from "./qr-binding-panel"
import { StreamingConfigField } from "./streaming-config-field"

interface WecomFormProps {
  config: ChannelConfig
  onChange: (key: string, value: unknown) => void
  configuredSecrets?: string[]
  fieldErrors?: Record<string, string>
  registerArrayFieldFlusher?: (
    fieldPath: string,
    flusher: ArrayFieldFlusher | null,
  ) => void
  arrayFieldResetVersion?: number
  onBindingComplete?: () => void
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function WecomForm({
  config,
  onChange,
  configuredSecrets = [],
  fieldErrors = {},
  registerArrayFieldFlusher,
  arrayFieldResetVersion,
  onBindingComplete,
}: WecomFormProps) {
  const { t } = useTranslation()
  const isBound =
    configuredSecrets.includes("secret") || asString(config.bot_id) !== ""

  return (
    <div className="space-y-6">
      <QrBindingPanel
        channel="wecom"
        isBound={isBound}
        onBindingComplete={onBindingComplete}
      />

      <Card className="shadow-sm">
        <CardContent className="divide-border/60 divide-y px-6 py-0 [&>div]:py-5">
          <Field
            label="Bot ID"
            required
            hint={t("channels.form.desc.genericField", {
              field: "WeCom bot id",
            })}
            error={fieldErrors.bot_id}
          >
            <Input
              value={asString(config.bot_id)}
              onChange={(e) => onChange("bot_id", e.target.value)}
              placeholder="wwxxxxxxxx"
            />
          </Field>

          <Field
            label="Secret"
            hint={t("channels.form.desc.genericField", {
              field: "WeCom bot secret",
            })}
            error={fieldErrors.secret}
          >
            <KeyInput
              value={asString(config._secret)}
              onChange={(value) => onChange("_secret", value)}
              placeholder={getSecretInputPlaceholder(
                configuredSecrets,
                "secret",
                t("channels.field.secretHintSet"),
                t("channels.field.secretPlaceholder"),
              )}
            />
          </Field>

          <Field
            label="Webhook URL"
            hint={t("channels.form.desc.webhookUrl")}
            error={fieldErrors.webhook_url}
          >
            <KeyInput
              value={asString(config._webhook_url)}
              onChange={(value) => onChange("_webhook_url", value)}
              placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
            />
          </Field>

          <ChannelArrayListField
            label={t("channels.field.allowFrom")}
            hint={t("channels.form.desc.allowFrom")}
            value={asStringArray(config.allow_from)}
            onChange={(value) => onChange("allow_from", value)}
            placeholder={t("channels.field.allowFromPlaceholder")}
            parser={parseAllowFromInput}
            fieldPath="allow_from"
            registerFlusher={registerArrayFieldFlusher}
            resetVersion={arrayFieldResetVersion}
          />

          <StreamingConfigField
            value={config.streaming}
            onChange={(value) => onChange("streaming", value)}
          />
        </CardContent>
      </Card>
    </div>
  )
}
