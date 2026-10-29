import { describe, expect, it } from "vitest"

import {
  EMPTY_ADD_FORM,
  buildAddModelPayload,
  generateUniqueModelName,
  getModelIdsToSave,
  validateAddFormState,
} from "./add-model-form-state"

describe("add model form state", () => {
  it("defaults every model selection field to empty", () => {
    expect(EMPTY_ADD_FORM.provider).toBe("")
    expect(EMPTY_ADD_FORM.model).toBe("")
    expect(EMPTY_ADD_FORM.apiKey).toBe("")
  })

  it("generates a unique six-character alias", () => {
    const alias = generateUniqueModelName(["model-a", "model-b"])
    expect(alias).toMatch(/^[a-z0-9]{6}$/)
    expect(["model-a", "model-b"]).not.toContain(alias)
  })

  it("uses the selected list in order and removes duplicate IDs", () => {
    expect(getModelIdsToSave([" model-a ", "model-b", "model-a", ""], "ignored")).toEqual([
      "model-a",
      "model-b",
    ])
    expect(getModelIdsToSave([], " model-single ")).toEqual(["model-single"])
    expect(getModelIdsToSave([], "   ")).toEqual([])
  })

  it("validates provider, model, and duplicate names as pure form state", () => {
    expect(validateAddFormState(EMPTY_ADD_FORM, {
      providerIsValid: false,
      existingModelNames: ["alpha"],
      selectedModels: [],
      messages: {
        duplicateModelName: "duplicate",
        providerInvalid: "provider required",
        modelRequired: "model required",
      },
    })).toEqual({ provider: "provider required", model: "model required" })

    expect(validateAddFormState({ ...EMPTY_ADD_FORM, modelName: "ALPHA", model: "model-a" }, {
      providerIsValid: true,
      existingModelNames: ["alpha"],
      selectedModels: [],
      messages: {
        duplicateModelName: "duplicate",
        providerInvalid: "provider required",
        modelRequired: "model required",
      },
    })).toEqual({ modelName: "duplicate" })
  })

  it("builds the API payload from the form with normalized optional fields", () => {
    const payload = buildAddModelPayload({
      ...EMPTY_ADD_FORM,
      apiKey: "  secret  ",
      requestTimeout: "30",
      rpm: "12",
      streamingEnabled: true,
    }, {
      modelName: "a1b2c3",
      modelId: "provider/model-a",
      provider: "provider-x",
      submittedApiBase: "https://example.test/v1",
      authMethodLocked: false,
      defaultAuthMethod: "",
      extraBody: { temperature: 0.2 },
      customHeaders: { "x-client": "miki" },
    })
    expect(payload).toMatchObject({
      model_name: "a1b2c3",
      model: "provider/model-a",
      provider: "provider-x",
      api_base: "https://example.test/v1",
      api_key: "secret",
      rpm: 12,
      request_timeout: 30,
      streaming: { enabled: true },
      extra_body: { temperature: 0.2 },
      custom_headers: { "x-client": "miki" },
    })
  })
})
