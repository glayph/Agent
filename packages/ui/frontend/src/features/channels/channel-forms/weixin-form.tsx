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
import {
  ChannelFieldCard,
  ChannelSection,
} from "@/features/channels/components/channel-section"
import { Field, KeyInput } from "@/shared/forms/shared-form"
import { Input } from "@/shared/ui/input"

import { QrBindingPanel } from "./qr-binding-panel"

interface WeixinFormProps {
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

export function WeixinForm({
  config,
  onChange,
  configuredSecrets = [],
  fieldErrors = {},
  registerArrayFieldFlusher,
  arrayFieldResetVersion,
  onBindingComplete,
}: WeixinFormProps) {
  const { t } = useTranslation()
  const isBound =
    configuredSecrets.includes("token") || asString(config.account_id) !== ""

  return (
    <div className="space-y-6">
      <ChannelSection
        title={t("channels.section.credentials")}
        description={t("channels.section.credentialsDesc")}
      >
        <div className="space-y-4">
          <QrBindingPanel
            channel="weixin"
            isBound={isBound}
            onBindingComplete={onBindingComplete}
          />
          <ChannelFieldCard>
            <Field
              label="Account ID"
              required
              hint={t("channels.form.desc.genericField", {
                field: "WeChat account id",
              })}
              error={fieldErrors.account_id}
            >
              <Input
                value={asString(config.account_id)}
                onChange={(e) => onChange("account_id", e.target.value)}
                placeholder="wxid_xxxxx"
              />
            </Field>
          </ChannelFieldCard>
        </div>
      </ChannelSection>

      <ChannelSection
        title={t("channels.section.access")}
        description={t("channels.section.accessDesc")}
      >
        <ChannelFieldCard>
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
        </ChannelFieldCard>
      </ChannelSection>

      <ChannelSection
        collapsible
        title={t("channels.section.advanced")}
        description={t("channels.section.advancedDesc")}
      >
        <ChannelFieldCard>
          <Field
            label="Token"
            hint={t("channels.form.desc.genericField", {
              field: "WeChat access token",
            })}
            error={fieldErrors.token}
          >
            <KeyInput
              value={asString(config._token)}
              onChange={(value) => onChange("_token", value)}
              placeholder={getSecretInputPlaceholder(
                configuredSecrets,
                "token",
                t("channels.field.secretHintSet"),
                t("channels.field.secretPlaceholder"),
              )}
            />
          </Field>

          <Field
            label={t("channels.field.proxy")}
            hint={t("channels.form.desc.proxy")}
          >
            <Input
              value={asString(config.proxy)}
              onChange={(e) => onChange("proxy", e.target.value)}
              placeholder="http://localhost:7890"
            />
          </Field>
        </ChannelFieldCard>
      </ChannelSection>
    </div>
  )
}
