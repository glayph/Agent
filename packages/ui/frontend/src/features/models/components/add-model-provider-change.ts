import type { ModelProviderOption } from "@/api/models"

import type { AddForm } from "./add-model-form-state"
import { normalizeApiBase } from "./model-provider-form-shared"
import {
  getCanonicalProviderKey,
  getProviderCatalogEntry,
  getProviderDefaultAPIBase,
} from "./provider-registry"

/**
 * Pure form transition when the provider changes: re-resolves the locked auth
 * method and drops an API base that was only the previous provider's default.
 */
export function applyProviderChange(
  form: AddForm,
  provider: string,
  providerOptions?: ModelProviderOption[],
): AddForm {
  const previousOption = getProviderCatalogEntry(form.provider, providerOptions)
  const nextOption = getProviderCatalogEntry(provider, providerOptions)
  const previousDefaultBase = normalizeApiBase(
    getProviderDefaultAPIBase(form.provider, providerOptions),
  )
  const nextDefaultBase = normalizeApiBase(
    getProviderDefaultAPIBase(provider, providerOptions),
  )
  const currentApiBase = normalizeApiBase(form.apiBase)
  let authMethod = form.authMethod
  let apiBase = form.apiBase
  if (nextOption?.authMethodLocked) {
    authMethod = nextOption.defaultAuthMethod ?? ""
  } else if (
    previousOption?.authMethodLocked &&
    form.authMethod === (previousOption.defaultAuthMethod ?? "")
  ) {
    authMethod = ""
  }
  if (
    currentApiBase &&
    previousDefaultBase &&
    currentApiBase === previousDefaultBase &&
    currentApiBase !== nextDefaultBase
  ) {
    apiBase = ""
  }
  return {
    ...form,
    provider: getCanonicalProviderKey(provider, providerOptions),
    apiBase,
    authMethod,
  }
}
