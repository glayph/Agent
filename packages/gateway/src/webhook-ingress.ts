import { timingSafeEqual } from "node:crypto"

const EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,79}$/

/** Shared secret for webhook ingress: env MIKI_WEBHOOK_SECRET wins, else autonomy.webhooks.secret. Empty = disabled. */
export function webhookSecret(config: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.MIKI_WEBHOOK_SECRET ?? "").trim()
  if (fromEnv) return fromEnv
  const autonomy = (config as { autonomy?: { webhooks?: { secret?: unknown } } } | undefined)?.autonomy
  const secret = autonomy?.webhooks?.secret
  return typeof secret === "string" ? secret.trim() : ""
}

/** Constant-time check of `Authorization: Bearer <secret>` or `X-Miki-Webhook-Secret: <secret>`. */
export function webhookAuthorized(secret: string, headers: { authorization?: string | string[]; "x-miki-webhook-secret"?: string | string[] }): boolean {
  if (!secret) return false
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ""
  const auth = first(headers.authorization)
  const supplied = (/^Bearer\s+(.+)$/i.exec(auth)?.[1] ?? first(headers["x-miki-webhook-secret"])).trim()
  const a = Buffer.from(supplied)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Returns the autonomy event name for a webhook (`webhook:<name>`), or null if the name is not acceptable. */
export function webhookEventName(name: unknown): string | null {
  return typeof name === "string" && EVENT_NAME.test(name) ? `webhook:${name}` : null
}
