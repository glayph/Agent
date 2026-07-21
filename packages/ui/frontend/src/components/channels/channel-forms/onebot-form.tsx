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
import { Field, KeyInput, SwitchCardField } from "@/components/shared-form"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

interface OneBotFormProps {
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

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

export function OneBotForm({
  config,
  onChange,
  configuredSecrets,
  fieldErrors = {},
  registerArrayFieldFlusher,
  arrayFieldResetVersion,
}: OneBotFormProps) {
  const groupTriggerConfig = asRecord(config.group_trigger)

  return (
    <div className="space-y-6">
      <Card className="shadow-sm">
        <CardContent className="divide-border/60 divide-y px-6 py-0 [&>div]:py-5">
          <Field
            label="Server URL"
            required
            hint="OneBot server URL"
            error={fieldErrors.server_url}
          >
            <Input
              value={asString(config.server_url)}
              onChange={(e) => onChange("server_url", e.target.value)}
              placeholder="ws://127.0.0.1:5700"
            />
          </Field>

          <Field
            label="Access Token"
            hint="OneBot access token if required"
            error={fieldErrors.access_token}
          >
            <KeyInput
              value={asString(config._access_token)}
              onChange={(value) => onChange("_access_token", value)}
              placeholder={getSecretInputPlaceholder(
                configuredSecrets,
                "access_token",
                "Already configured. Leave blank to keep unchanged.",
                "Optional",
              )}
            />
          </Field>

          <Field
            label="Bot ID"
            hint="Bot QQ/self ID. Required for mention-only group routing."
          >
            <Input
              value={asString(config.bot_id)}
              onChange={(e) => onChange("bot_id", e.target.value)}
              placeholder="123456789"
            />
          </Field>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardContent className="divide-border/60 divide-y px-6 py-0 [&>div]:py-5">
          <ChannelArrayListField
            label="Allow From"
            hint="Allowed user or group IDs. Supports user:123 and group:456."
            value={asStringArray(config.allow_from)}
            onChange={(value) => onChange("allow_from", value)}
            placeholder="user:123456, group:789012"
            parser={parseAllowFromInput}
            fieldPath="allow_from"
            registerFlusher={registerArrayFieldFlusher}
            resetVersion={arrayFieldResetVersion}
          />

          <div>
            <SwitchCardField
              label="Mention Only"
              hint="In group chats, respond only when mentioned or prefixed."
              checked={groupTriggerConfig.mention_only !== false}
              onCheckedChange={(checked) => {
                onChange("group_trigger", {
                  ...groupTriggerConfig,
                  mention_only: checked,
                })
              }}
              ariaLabel="Mention Only"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
