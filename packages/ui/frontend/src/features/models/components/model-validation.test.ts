import { describe, expect, it } from "vitest"

import { validateModelField } from "./model-validation"

const providerOptions = [
  {
    id: "openai",
    display_name: "OpenAI",
    default_api_base: "https://api.openai.com/v1",
    empty_api_key_allowed: false,
    create_allowed: true,
    default_model_allowed: true,
    aliases: ["oai"],
  },
]

describe("model validation", () => {
  it("accepts empty values and provider-local model names", () => {
    expect(validateModelField("   ")).toEqual({ level: "success", messageKey: "" })
    expect(validateModelField("gpt-4.1-mini", "openai")).toMatchObject({
      level: "success",
      messageKey: "models.validation.parsed",
      messageParams: { provider: "openai", model: "gpt-4.1-mini" },
    })
  })

  it("returns actionable fixes for invalid separators", () => {
    expect(validateModelField("openai gpt-4.1-mini")).toMatchObject({
      level: "error",
      messageKey: "models.validation.whitespace",
      fix: "openai/gpt-4.1-mini",
    })
    expect(validateModelField("/openai/gpt-4.1-mini")).toMatchObject({
      level: "error",
      messageKey: "models.validation.leadingSlash",
      fix: "openai/gpt-4.1-mini",
    })
    expect(validateModelField("openai//gpt-4.1-mini")).toMatchObject({
      level: "error",
      messageKey: "models.validation.consecutiveSlash",
      fix: "openai/gpt-4.1-mini",
    })
  })

  it("suggests a default provider when no provider is selected", () => {
    expect(validateModelField("gpt-4.1-mini")).toMatchObject({
      level: "warning",
      messageKey: "models.validation.defaultToOpenAI",
      fix: "openai/gpt-4.1-mini",
    })
  })

  it("accepts known provider-prefixed model identifiers", () => {
    expect(validateModelField("openai/gpt-4.1-mini", undefined, providerOptions)).toMatchObject({
      level: "success",
      messageKey: "models.validation.parsed",
      messageParams: { provider: "openai", model: "gpt-4.1-mini" },
    })
  })
})
