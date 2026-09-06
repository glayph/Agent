import { describe, expect, it } from "vitest"

import { validateModelField } from "./model-validation"

const providerOptions = [
  {
    id: "google",
    display_name: "Google Gemini",
    default_api_base:
      "https://generativelanguage.googleapis.com/v1beta/openai/",
    empty_api_key_allowed: false,
    create_allowed: true,
    default_model_allowed: true,
    aliases: ["gemini"],
  },
  {
    id: "llama.cpp",
    display_name: "llama.cpp Local",
    default_api_base: "http://127.0.0.1:39200/v1",
    empty_api_key_allowed: true,
    create_allowed: true,
    default_model_allowed: true,
    aliases: ["llama-cpp", "local"],
  },
]

describe("model validation", () => {
  it("accepts empty values and provider-local model names", () => {
    expect(validateModelField("   ")).toEqual({
      level: "success",
      messageKey: "",
    })
    expect(validateModelField("gemini-3.5-flash-lite", "google")).toMatchObject({
      level: "success",
      messageKey: "models.validation.parsed",
      messageParams: { provider: "google", model: "gemini-3.5-flash-lite" },
    })
  })

  it("returns actionable fixes for invalid separators", () => {
    expect(validateModelField("gemini gemini-3.5-flash-lite")).toMatchObject({
      level: "error",
      messageKey: "models.validation.whitespace",
      fix: "gemini/gemini-3.5-flash-lite",
    })
    expect(validateModelField("/gemini/gemini-3.5-flash-lite")).toMatchObject({
      level: "error",
      messageKey: "models.validation.leadingSlash",
      fix: "gemini/gemini-3.5-flash-lite",
    })
    expect(validateModelField("gemini//gemini-3.5-flash-lite")).toMatchObject({
      level: "error",
      messageKey: "models.validation.consecutiveSlash",
      fix: "gemini/gemini-3.5-flash-lite",
    })
  })

  it("suggests Gemini when no provider is selected", () => {
    expect(validateModelField("gemini-3.5-flash-lite")).toMatchObject({
      level: "warning",
      messageKey: "models.validation.defaultToGemini",
      fix: "gemini/gemini-3.5-flash-lite",
    })
  })

  it("accepts known provider-prefixed model identifiers", () => {
    expect(
      validateModelField(
        "google/gemini-3.5-flash-lite",
        undefined,
        providerOptions,
      ),
    ).toMatchObject({
      level: "success",
      messageKey: "models.validation.parsed",
      messageParams: {
        provider: "google",
        model: "gemini-3.5-flash-lite",
      },
    })
  })
})
