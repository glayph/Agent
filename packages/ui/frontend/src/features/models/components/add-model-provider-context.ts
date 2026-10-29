import type { ModelProviderOption } from "@/api/models"

import type { AddForm } from "./add-model-form-state"
import { getEffectiveAPIBase } from "./model-provider-form-shared"
import {
  getCanonicalProviderKey,
  getProviderCatalogMap,
  getProviderDefaultAuthMethod,
  isProviderAuthMethodLocked,
  providerSupportsFetch,
} from "./provider-registry"

/** Provider-derived values the Add Model form renders from (pure, no state). */
export function getAddModelProviderContext(
  form: AddForm,
  providerOptions?: ModelProviderOption[],
) {
  const canonicalProvider = getCanonicalProviderKey(
    form.provider,
    providerOptions,
  )
  const providerDef = canonicalProvider
    ? getProviderCatalogMap(providerOptions).get(canonicalProvider)
    : undefined
  const authMethodLocked = isProviderAuthMethodLocked(
    form.provider,
    providerOptions,
  )
  const defaultAuthMethod = getProviderDefaultAuthMethod(
    form.provider,
    providerOptions,
  )
  const effectiveAuthMethod = (
    authMethodLocked ? defaultAuthMethod : form.authMethod
  )
    .trim()
    .toLowerCase()
  const isOAuth = effectiveAuthMethod === "oauth"
  return {
    canonicalProvider,
    providerDef,
    commonModels: providerDef?.commonModels || [],
    authMethodLocked,
    defaultAuthMethod,
    effectiveAuthMethod,
    isOAuth,
    effectiveApiBase: getEffectiveAPIBase(
      form.provider,
      form.apiBase,
      providerOptions,
    ),
    supportsFetch: providerSupportsFetch(form.provider, providerOptions),
    missingApiKey: !form.apiKey.trim() && !isOAuth,
    defaultModelAllowed: providerDef?.defaultModelAllowed === true,
  }
}
