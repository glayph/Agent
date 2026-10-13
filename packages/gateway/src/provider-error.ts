/** Failure categories the UI knows how to explain (missing key, local model down, provider error, network). */
export type ProviderErrorCategory = "provider_api_key" | "local_model_unavailable" | "upstream_provider_error" | "provider_network"

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly category: ProviderErrorCategory,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "ProviderRequestError"
  }
}
