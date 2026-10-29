import { describe, expect, it } from "vitest"

import bn from "./locales/bn.json"
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
    bn: flattenLocale(bn),
    "pt-BR": flattenLocale(ptBr),
    zh: flattenLocale(zh),
  }
  const englishKeys = Object.keys(locales.en).sort()

  it("keeps every locale key in parity with English", () => {
    for (const [localeName, locale] of Object.entries(locales)) {
      if (localeName === "bn") {
        expect(Object.keys(locale).every((key) => englishKeys.includes(key)), localeName).toBe(true)
        continue
      }
      expect(Object.keys(locale).sort(), localeName).toEqual(englishKeys)
    }
  })

  it("requires Bengali key parity with English for channels, models and chat", () => {
    const bengaliScoped = ["channels.", "models.", "chat."]
    const scoped = (key: string) => bengaliScoped.some((prefix) => key.startsWith(prefix))
    const required = englishKeys.filter(scoped)
    const missing = required.filter((key) => locales.bn[key] === undefined)
    expect(missing, "bn is missing keys that exist in en").toEqual([])
    const unexpected = Object.keys(locales.bn).filter((key) => !englishKeys.includes(key))
    expect(unexpected, "bn has keys that en does not").toEqual([])
  })

  it("uses _one/_other plural keys only (legacy _plural is ignored by i18next 26)", () => {
    for (const [localeName, locale] of Object.entries(locales)) {
      const keys = Object.keys(locale)
      expect(keys.filter((key) => key.endsWith("_plural")), localeName).toEqual([])
      const missingOther = keys.filter((key) => key.endsWith("_one") && locale[key.replace(/_one$/, "_other")] === undefined)
      expect(missingOther, `${localeName} has _one without _other`).toEqual([])
    }
  })

  it("keeps interpolation placeholders compatible across locales", () => {
    for (const key of englishKeys) {
      const expected = placeholders(locales.en[key])
      for (const [localeName, locale] of Object.entries(locales)) {
        if (locale[key] === undefined) continue
        expect(placeholders(locale[key]), `${localeName}:${key}`).toEqual(expected)
      }
    }
  })

  it("translates the new redesign keys into Bengali", () => {
    const requiredBengaliKeys = [
      "models.add.batchSaveSuccess",
      "models.fetch.alreadyAdded",
      "models.fetch.addSelected",
      "chat.actions.more",
      "chat.tools.used",
      "channels.catalog.groups.live",
      "channels.catalog.truthNotice",
      "channels.page.messagesNotDelivered",
      "channels.page.allowFromWarning",
    ]
    for (const key of requiredBengaliKeys) {
      expect(locales.bn[key], key).toBeTruthy()
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
