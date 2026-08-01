import { describe, expect, it } from "vitest"

import en from "./locales/en.json"
import ptBr from "./locales/pt-br.json"
import zh from "./locales/zh.json"

type LocaleTree = Record<string, unknown>

function flattenLocale(
  value: LocaleTree,
  prefix = "",
  output: Record<string, string> = {},
): Record<string, string> {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === "object" && !Array.isArray(child)) {
      flattenLocale(child as LocaleTree, path, output)
      continue
    }
    output[path] = typeof child === "string" ? child : String(child ?? "")
  }
  return output
}

function placeholders(text: string): string[] {
  return Array.from(text.matchAll(/{{\s*([\w.-]+)\s*}}/g))
    .map((match) => match[1])
    .sort()
}

describe("locale resources", () => {
  const locales = {
    en: flattenLocale(en),
    "pt-BR": flattenLocale(ptBr),
    zh: flattenLocale(zh),
  }
  const englishKeys = Object.keys(locales.en).sort()

  it("keeps every locale key in parity with English", () => {
    for (const [localeName, locale] of Object.entries(locales)) {
      expect(Object.keys(locale).sort(), localeName).toEqual(englishKeys)
    }
  })

  it("keeps interpolation placeholders compatible across locales", () => {
    for (const key of englishKeys) {
      const expected = placeholders(locales.en[key])
      for (const [localeName, locale] of Object.entries(locales)) {
        expect(placeholders(locale[key]), `${localeName}:${key}`).toEqual(
          expected,
        )
      }
    }
  })

  it("does not ship empty translation strings", () => {
    for (const [localeName, locale] of Object.entries(locales)) {
      for (const [key, value] of Object.entries(locale)) {
        expect(value.trim(), `${localeName}:${key}`).not.toBe("")
      }
    }
  })
})
