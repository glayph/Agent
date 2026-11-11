/** Failure categories the UI knows how to explain (missing key, local model down, provider error, network). */
export type ProviderErrorCategory = "provider_api_key" | "provider_authorization" | "provider_entitlement" | "provider_rate_limit" | "model_not_found" | "provider_bad_request" | "provider_unavailable" | "local_model_unavailable" | "upstream_provider_error" | "provider_network"


const ENTITLEMENT_CODES = new Set([
  "payment_required", "payment_method_required", "billing_hard_limit",
  "billing_not_active", "account_payment_required", "insufficient_quota",
])

/** Classify an HTTP completion response from its status and structured provider identifiers only. */
export function classifyProviderHttpError(status: number, code?: string, type?: string): ProviderErrorCategory {
  const identifiers = [code, type].filter(Boolean).map((value) => String(value).toLowerCase())
  const entitlement = identifiers.some((value) => ENTITLEMENT_CODES.has(value))
  if (status === 402 || (status !== 401 && entitlement)) return "provider_entitlement"
  if (status === 401) return "provider_api_key"
  if (status === 403) return "provider_authorization"
  if (status === 404 || identifiers.some((value) => /model_not_found|model_unavailable|model_not_supported|unsupported_model|invalid_model/.test(value))) return "model_not_found"
  if (status === 400) return "provider_bad_request"
  if (status === 429) return "provider_rate_limit"
  if (status >= 500) return "provider_unavailable"
  return "upstream_provider_error"
}

function redactProviderMessage(value: string, knownSecrets: readonly string[] = []): string {
  let safe = value
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|token|authorization|secret|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[redacted-token]")
    .replace(/https?:\/\/[^\s]+/gi, "[endpoint]");
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) safe = safe.split(secret).join("[redacted]");
  }
  return safe.slice(0, 500)
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly category: ProviderErrorCategory,
    readonly provider: string,
    readonly status?: number,
    readonly providerCode?: string,
    readonly providerType?: string,
    knownSecrets: readonly string[] = [],
  ) {
    super(redactProviderMessage(message, knownSecrets))
    this.name = "ProviderRequestError"
  }
}
