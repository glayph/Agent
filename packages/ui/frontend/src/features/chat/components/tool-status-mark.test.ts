import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import i18next from "i18next"
import { I18nextProvider, initReactI18next } from "react-i18next"
import { describe, expect, it } from "vitest"

import bn from "@/i18n/locales/bn.json"
import en from "@/i18n/locales/en.json"
import type { ChatToolCall } from "@/store/chat"

import { ToolCallSummaryMeta } from "./tool-status-mark"

function render(toolCalls: ChatToolCall[] | undefined, lng: "en" | "bn" = "en") {
  const instance = i18next.createInstance()
  void instance.use(initReactI18next).init({
    lng,
    fallbackLng: "en",
    resources: { en: { translation: en }, bn: { translation: bn } },
    interpolation: { escapeValue: false },
    initAsync: false,
  })
  return renderToStaticMarkup(
    createElement(I18nextProvider, { i18n: instance }, createElement(ToolCallSummaryMeta, { toolCalls })),
  )
}

describe("tool call summary meta", () => {
  it("marks a failed tool in red and totals the duration", () => {
    const html = render([
      { id: "a", status: "success", durationMs: 84 },
      { id: "b", status: "error", durationMs: 4210 },
    ])
    expect(html).toContain("text-destructive")
    expect(html).toContain("1 failed")
    expect(html).toContain("4.3 s")
  })

  it("shows a success mark only when every call succeeded", () => {
    expect(render([{ id: "a", status: "success", durationMs: 200 }])).toContain("All tools succeeded")
    expect(render([{ id: "a", status: "success" }, { id: "b" }])).not.toContain("All tools succeeded")
  })

  it("shows a running mark and no duration while a tool is running", () => {
    const html = render([{ id: "a", status: "running" }])
    expect(html).toContain("Running")
    expect(html).not.toMatch(/\d+ (ms|s)\b/)
  })

  it("renders nothing when the gateway sent no status or duration", () => {
    expect(render([{ id: "a" }, { id: "b" }])).toBe("")
    expect(render(undefined)).toBe("")
  })

  it("is translated into Bengali", () => {
    const html = render([{ id: "a", status: "error", durationMs: 500 }], "bn")
    expect(html).toContain("টি ব্যর্থ")
    expect(html).toContain("500 মিলিসেকেন্ড")
  })
})
