import type { AddModelFieldIds } from "./add-model-fields"

/** Stable DOM ids for every Add Model form field, derived from one React id. */
export function createAddModelFieldIds(formId: string): AddModelFieldIds {
  return {
    modelName: `${formId}-model-name`,
    provider: `${formId}-provider`,
    model: `${formId}-model-id`,
    apiKey: `${formId}-api-key`,
    apiBase: `${formId}-api-base`,
    proxy: `${formId}-proxy`,
    authMethod: `${formId}-auth-method`,
    connectMode: `${formId}-connect-mode`,
    workspace: `${formId}-workspace`,
    requestTimeout: `${formId}-request-timeout`,
    rpm: `${formId}-rpm`,
    thinkingLevel: `${formId}-thinking-level`,
    maxTokensField: `${formId}-max-tokens-field`,
    toolSchemaTransform: `${formId}-tool-schema-transform`,
    extraBody: `${formId}-extra-body`,
    customHeaders: `${formId}-custom-headers`,
  }
}
