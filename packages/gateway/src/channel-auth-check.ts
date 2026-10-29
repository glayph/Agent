/**
 * Read-only credential verification for the dashboard "live" channel probe.
 *
 * - telegram: GET  /bot<token>/getMe
 * - discord:  GET  /api/v10/users/@me        (Discord has no auth.test; this is its read-only identity call)
 * - slack:    POST /api/auth.test            (bot token)
 *
 * Guarantees:
 * - never sends a message or mutates anything on the provider;
 * - hard 8 second timeout;
 * - the credential is never part of the returned object (messages are fixed
 *   strings, upstream text is never reflected) and is never logged or stored;
 * - redirects are not followed, so a credential can't be forwarded elsewhere.
 */

export const CHANNEL_AUTH_TIMEOUT_MS = 8_000

export const AUTH_CHECK_CHANNELS = ["telegram", "discord", "slack"] as const
export type AuthCheckChannel = (typeof AUTH_CHECK_CHANNELS)[number]

export type ChannelAuthFailureCode = "auth_rejected" | "auth_timeout" | "auth_network_error" | "auth_unexpected_response"

export interface ChannelAuthCheckResult {
  ok: boolean
  status: "pass" | "fail"
  message: string
  latencyMs: number
  failureCode?: ChannelAuthFailureCode
}

export function supportsAuthCheck(name: string): name is AuthCheckChannel {
  return (AUTH_CHECK_CHANNELS as readonly string[]).includes(name)
}

/** The credential field the live check needs for each supported channel. */
export function authCredentialKey(name: AuthCheckChannel): string {
  return name === "slack" ? "bot_token" : "token"
}

interface RequestSpec {
  url: string
  init: RequestInit
  /** Decides whether a 2xx JSON body means "authenticated". */
  accepts: (body: unknown) => boolean
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function buildRequest(name: AuthCheckChannel, credential: string): RequestSpec {
  switch (name) {
    case "telegram":
      return {
        url: `https://api.telegram.org/bot${encodeURIComponent(credential)}/getMe`,
        init: { method: "GET" },
        accepts: (body) => recordOf(body).ok === true,
      }
    case "discord":
      return {
        url: "https://discord.com/api/v10/users/@me",
        init: { method: "GET", headers: { authorization: `Bot ${credential}` } },
        accepts: (body) => typeof recordOf(body).id === "string",
      }
    case "slack":
      return {
        url: "https://slack.com/api/auth.test",
        init: { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/x-www-form-urlencoded" }, body: "" },
        accepts: (body) => recordOf(body).ok === true,
      }
  }
}

const fail = (message: string, latencyMs: number, failureCode: ChannelAuthFailureCode): ChannelAuthCheckResult => ({
  ok: false,
  status: "fail",
  message,
  latencyMs,
  failureCode,
})

export async function runChannelAuthCheck(
  name: AuthCheckChannel,
  credential: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number } = {},
): Promise<ChannelAuthCheckResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? CHANNEL_AUTH_TIMEOUT_MS
  const now = options.now ?? Date.now
  const started = now()
  const spec = buildRequest(name, credential)
  try {
    const response = await fetchImpl(spec.url, {
      ...spec.init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    })
    const latencyMs = Math.max(0, now() - started)
    if (response.status === 401 || response.status === 403 || (response.status === 404 && name === "telegram")) {
      return fail("The provider rejected the credential.", latencyMs, "auth_rejected")
    }
    if (response.status < 200 || response.status >= 300) {
      return fail(`The provider returned an unexpected status (${response.status}).`, latencyMs, "auth_unexpected_response")
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return fail("The provider returned an unreadable response.", latencyMs, "auth_unexpected_response")
    }
    if (spec.accepts(body)) {
      return { ok: true, status: "pass", message: "The provider accepted the credential. No message was sent.", latencyMs }
    }
    return fail("The provider rejected the credential.", latencyMs, "auth_rejected")
  } catch (error) {
    const latencyMs = Math.max(0, now() - started)
    const errorName = error instanceof Error ? error.name : ""
    if (errorName === "TimeoutError" || errorName === "AbortError") {
      return fail(`The provider did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, latencyMs, "auth_timeout")
    }
    // The raw error text can contain the request URL (which holds the Telegram token), so it is never surfaced.
    return fail("The provider could not be reached.", latencyMs, "auth_network_error")
  }
}
