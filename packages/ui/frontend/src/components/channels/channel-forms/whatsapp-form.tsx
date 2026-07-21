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

interface WhatsAppFormProps {
  config: ChannelConfig
  onChange: (key: string, value: unknown) => void
  configuredSecrets?: string[]
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

export function WhatsAppForm({
  config,
  onChange,
  configuredSecrets = [],
  fieldErrors = {},
  registerArrayFieldFlusher,
  arrayFieldResetVersion,
}: WhatsAppFormProps) {
  return (
    <div className="space-y-6">
      <Card className="shadow-sm">
        <CardContent className="divide-border/60 divide-y px-6 py-0 [&>div]:py-5">
          <Field
            label="Bridge URL"
            required
            hint="WhatsApp bridge endpoint"
            error={fieldErrors.bridge_url}
          >
            <Input
              value={asString(config.bridge_url)}
              onChange={(e) => onChange("bridge_url", e.target.value)}
              placeholder="https://bridge.example.com"
            />
          </Field>

          <Field
            label="Webhook Token"
            hint="Optional shared token accepted from the bridge and reused for outbound bridge calls"
            error={fieldErrors.webhook_token}
          >
            <KeyInput
              value={asString(config._webhook_token)}
              onChange={(value) => onChange("_webhook_token", value)}
              placeholder={getSecretInputPlaceholder(
                configuredSecrets,
                "webhook_token",
                "Already configured. Leave blank to keep unchanged.",
                "Optional",
              )}
            />
          </Field>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardContent className="divide-border/60 divide-y px-6 py-0 [&>div]:py-5">
          <ChannelArrayListField
            label="Allow From"
            hint="Allowed WhatsApp chat or sender IDs. Supports chat: and sender: prefixes."
            value={asStringArray(config.allow_from)}
            onChange={(value) => onChange("allow_from", value)}
            placeholder="chat:120363000000000000@g.us, sender:8801000000000"
            parser={parseAllowFromInput}
            fieldPath="allow_from"
            registerFlusher={registerArrayFieldFlusher}
            resetVersion={arrayFieldResetVersion}
          />
        </CardContent>
      </Card>
    </div>
  )
}

export function WhatsAppNativeForm({
  config,
  onChange,
  fieldErrors = {},
}: WhatsAppFormProps) {
  return (
    <div className="space-y-6">
      <Card className="shadow-sm">
        <CardContent className="divide-border/60 divide-y px-6 py-0 [&>div]:py-5">
          <Field
            label="Configuration"
            required
            hint="WhatsApp native Baileys configuration"
            error={fieldErrors.config}
          >
            <Input
              value={asString(config.config)}
              onChange={(e) => onChange("config", e.target.value)}
              placeholder="Configuration details"
            />
          </Field>
        </CardContent>
      </Card>
    </div>
  )
}
