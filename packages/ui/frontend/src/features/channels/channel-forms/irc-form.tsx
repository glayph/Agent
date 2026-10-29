import { useTranslation } from "react-i18next"

import type { ChannelConfig } from "@/api/channels"
import {
  ChannelFieldCard,
  ChannelSection,
} from "@/features/channels/components/channel-section"
import { Field } from "@/shared/forms/shared-form"
import { Input } from "@/shared/ui/input"
import { Switch } from "@/shared/ui/switch"

interface IRCFormProps {
  config: ChannelConfig
  onChange: (key: string, value: unknown) => void
  fieldErrors?: Record<string, string>
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asBoolean(value: unknown): boolean {
  return value === true
}

export function IRCForm({ config, onChange, fieldErrors = {} }: IRCFormProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <ChannelSection
        title={t("channels.section.credentials")}
        description={t("channels.section.credentialsDesc")}
      >
        <ChannelFieldCard>
          <Field
            label="Server"
            required
            hint="IRC server address"
            error={fieldErrors.server}
          >
            <Input
              value={asString(config.server)}
              onChange={(e) => onChange("server", e.target.value)}
              placeholder="irc.libera.chat"
            />
          </Field>

          <Field
            label="Nickname"
            required
            hint="Bot nickname"
            error={fieldErrors.nick}
          >
            <Input
              value={asString(config.nick)}
              onChange={(e) => onChange("nick", e.target.value)}
              placeholder="Miki"
            />
          </Field>
        </ChannelFieldCard>
      </ChannelSection>

      <ChannelSection
        collapsible
        title={t("channels.section.advanced")}
        description={t("channels.section.advancedDesc")}
      >
        <ChannelFieldCard>
          <Field label="Port" hint="IRC server port" error={fieldErrors.port}>
            <Input
              value={asString(config.port)}
              onChange={(e) => onChange("port", e.target.value)}
              placeholder="6667"
              type="number"
            />
          </Field>

          <Field
            label="Channels"
            hint="Comma-separated list of channels to join"
            error={fieldErrors.channels}
          >
            <Input
              value={asString(config.channels)}
              onChange={(e) => onChange("channels", e.target.value)}
              placeholder="#general,#dev"
            />
          </Field>

          <Field
            label="TLS"
            hint="Use TLS, usually on port 6697"
            error={fieldErrors.tls}
          >
            <Switch
              checked={asBoolean(config.tls ?? config.use_tls)}
              onCheckedChange={(checked) => onChange("tls", checked)}
              aria-label="TLS"
            />
          </Field>

          <Field
            label="Server Password"
            hint="Optional IRC PASS secret"
            error={fieldErrors.password}
          >
            <Input
              value={asString(config.password)}
              onChange={(e) => onChange("password", e.target.value)}
              placeholder="Optional"
              type="password"
            />
          </Field>

          <Field
            label="NickServ Password"
            hint="Optional NickServ IDENTIFY secret"
            error={fieldErrors.nickserv_password}
          >
            <Input
              value={asString(config.nickserv_password)}
              onChange={(e) => onChange("nickserv_password", e.target.value)}
              placeholder="Optional"
              type="password"
            />
          </Field>
        </ChannelFieldCard>
      </ChannelSection>
    </div>
  )
}
