import type { ChannelConfig } from "@/api/channels"
import { Field } from "@/components/shared-form"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"

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
  return (
    <div className="space-y-6">
      <Card className="shadow-sm">
        <CardContent className="divide-border/60 divide-y px-6 py-0 [&>div]:py-5">
          <Field label="Server" required hint="IRC server address" error={fieldErrors.server}>
            <Input
              value={asString(config.server)}
              onChange={(e) => onChange("server", e.target.value)}
              placeholder="irc.libera.chat"
            />
          </Field>

          <Field label="Port" hint="IRC server port" error={fieldErrors.port}>
            <Input
              value={asString(config.port)}
              onChange={(e) => onChange("port", e.target.value)}
              placeholder="6667"
              type="number"
            />
          </Field>

          <Field label="Nickname" required hint="Bot nickname" error={fieldErrors.nick}>
            <Input
              value={asString(config.nick)}
              onChange={(e) => onChange("nick", e.target.value)}
              placeholder="Hiro"
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

          <Field label="TLS" hint="Use TLS, usually on port 6697" error={fieldErrors.tls}>
            <Switch
              checked={asBoolean(config.tls ?? config.use_tls)}
              onCheckedChange={(checked) => onChange("tls", checked)}
              aria-label="TLS"
            />
          </Field>

          <Field label="Server Password" hint="Optional IRC PASS secret" error={fieldErrors.password}>
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
        </CardContent>
      </Card>
    </div>
  )
}
