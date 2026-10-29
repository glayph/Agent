import { useEffect, useState } from "react"

import { type ModelProviderOption, getCatalogs } from "@/api/models"

import { getEffectiveAPIBase } from "./model-provider-form-shared"
import { getCanonicalProviderKey } from "./provider-registry"

/** Model ids the catalog lists for the chosen provider + API base. */
export function useCatalogModels(
  provider: string,
  apiBaseInput: string,
  providerOptions?: ModelProviderOption[],
): string[] {
  const [catalogModels, setCatalogModels] = useState<string[]>([])

  useEffect(() => {
    if (!provider.trim()) {
      setCatalogModels([])
      return
    }
    const providerKey = getCanonicalProviderKey(provider, providerOptions)
    const apiBase = getEffectiveAPIBase(provider, apiBaseInput, providerOptions)
    let cancelled = false
    getCatalogs()
      .then((res) => {
        if (cancelled) return
        const ids = (res.entries || [])
          .filter((entry) => {
            const entryProvider = getCanonicalProviderKey(
              entry.provider,
              providerOptions,
            )
            const entryBase = (entry.api_base ?? "").trim().replace(/\/+$/, "")
            return entryProvider === providerKey && entryBase === apiBase
          })
          .flatMap((entry) => entry.models.map((model) => model.id))
        setCatalogModels([...new Set(ids)])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [provider, apiBaseInput, providerOptions])

  return catalogModels
}
