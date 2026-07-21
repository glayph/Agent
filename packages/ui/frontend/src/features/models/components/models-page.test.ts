import { describe, expect, it } from "vitest"

import type { ModelInfo, ModelProviderOption } from "@/api/models"

import { buildProviderGroups } from "./models-page-model"

function model(overrides: Partial<ModelInfo>): ModelInfo {
  return {
    index: overrides.index ?? 1,
    model_name: overrides.model_name ?? "openai/gpt-4.1-mini",
    provider: overrides.provider ?? "openai",
    model: overrides.model ?? "gpt-4.1-mini",
    api_key: "",
    enabled: true,
    available: true,
    status: "available",
    is_default: false,
    is_virtual: false,
    ...overrides,
  }
}

const providers: ModelProviderOption[] = [
  {
    id: "openai",
    display_name: "OpenAI",
    default_api_base: "https://api.openai.com/v1",
    empty_api_key_allowed: false,
    create_allowed: true,
    default_model_allowed: true,
    priority: 10,
    aliases: ["oai"],
  },
  {
    id: "anthropic",
    display_name: "Anthropic",
    default_api_base: "https://api.anthropic.com/v1",
    empty_api_key_allowed: false,
    create_allowed: true,
    default_model_allowed: true,
    priority: 8,
  },
]

describe("models page grouping", () => {
  it("groups provider aliases and prioritizes the default provider section", () => {
    const groups = buildProviderGroups(
      [
        model({
          index: 1,
          provider: "anthropic",
          model_name: "anthropic/claude-sonnet",
        }),
        model({
          index: 2,
          provider: "oai",
          model_name: "openai/gpt-4.1",
          is_default: true,
        }),
        model({
          index: 3,
          provider: "openai",
          model_name: "openai/gpt-4.1-mini",
          available: false,
          status: "unconfigured",
        }),
      ],
      providers,
    )

    expect(groups.map((group) => group.key)).toEqual(["openai", "anthropic"])
    expect(groups[0].hasDefault).toBe(true)
    expect(groups[0].availableCount).toBe(1)
    expect(groups[0].models.map((item) => item.model_name)).toEqual([
      "openai/gpt-4.1",
      "openai/gpt-4.1-mini",
    ])
  })
})
