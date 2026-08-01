import { useTranslation } from "react-i18next"

import type { ChannelConfig } from "@/api/channels"
import {
  type ArrayFieldFlusher,
  ChannelArrayListField,
} from "@/features/channels/components/channel-array-list-field"
import {
  asStringArray,
  parseAllowFromInput,
} from "@/features/channels/components/channel-array-utils"
import { getSecretInputPlaceholder } from "@/features/channels/components/channel-config-fields"
import { Field, KeyInput, SwitchCardField } from "@/shared/forms/shared-form"
import { Card, CardContent } from "@/shared/ui/card"
import { Input } from "@/shared/ui/input"

interface DiscordFormProps {
  config: ChannelConfig
  onChange: (key: string, value: unknown) => void
  configuredSecrets: string[]
  fieldErrors?: Record<string, string>
  registerArrayFieldFlusher?: (
    fieldPath: string,
    flusher: ArrayFieldFlusher | null,
  ) => void
  arrayFieldResetVersion?: number
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asBool(value: unknown): boolean {
  return value === true
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

export function DiscordForm({
  config,
  onChange,
  configuredSecrets,
  fieldErrors = {},
  registerArrayFieldFlusher,
  arrayFieldResetVersion,
}: DiscordFormProps) {
  const { t } = useTranslation()
  const groupTriggerConfig = asRecord(config.group_trigger)

  return (
    <div className="space-y-6">
      <Card className="shadow-sm">
        <CardContent className="divide-border/60 divide-y px-6 py-0 [&>div]:py-5">
          <Field
            label={t("channels.field.token")}
            required
            hint={t("channels.form.desc.token")}
            error={fieldErrors.token}
          >
            <KeyInput
              value={asString(config._token)}
              onChange={(v) => onChange("_token", v)}
              placeholder={getSecretInputPlaceholder(
                configuredSecrets,
                "token",
                t("channels.field.secretHintSet"),
                t("channels.field.tokenPlaceholder"),
              )}
            />
          </Field>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardContent className="divide-border/60 divide-y px-6 py-0 [&>div]:py-5">
          <Field
            label={t("channels.field.proxy")}
            hint={t("channels.form.desc.proxy")}
          >
            <Input
              value={asString(config.proxy)}
              onChange={(e) => onChange("proxy", e.target.value)}
              placeholder="http://127.0.0.1:7890"
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

          <div>
            <SwitchCardField
              label={t("channels.field.mentionOnly")}
              hint={t("channels.form.desc.mentionOnly")}
              checked={asBool(groupTriggerConfig.mention_only)}
              onCheckedChange={(checked) => {
                onChange("group_trigger", {
                  ...groupTriggerConfig,
                  mention_only: checked,
                })
              }}
              ariaLabel={t("channels.field.mentionOnly")}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
