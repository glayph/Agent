import { describe, expect, it } from "vitest"

import {
  preservesFullAssistantContent,
  visibleAssistantContent,
} from "./assistant-message-content"

describe("assistant structured-content visibility", () => {
  it("preserves complete Python functions", () => {
    const content =
      "def average_line_revenue(rows):\n    if not rows:\n        return 0.0\n    return sum(row['units'] * row['unit_price'] for row in rows) / len(rows)"

    expect(preservesFullAssistantContent(content)).toBe(true)
    expect(visibleAssistantContent(content)).toBe(content)
  })

  it("preserves valid JSON objects", () => {
    const content =
      '{"project":"Aurora Desk","owner":"Mina","priority":"high","due_date":"2026-09-15"}'

    expect(preservesFullAssistantContent(content)).toBe(true)
    expect(visibleAssistantContent(content)).toBe(content)
  })

  it("preserves markdown links so direct URLs remain clickable", () => {
    const content =
      "Official page: [MDN video](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video)"

    expect(preservesFullAssistantContent(content)).toBe(true)
    expect(visibleAssistantContent(content)).toBe(content)
  })

  it("keeps ordinary long prose compact", () => {
    const content = Array.from(
      { length: 8 },
      (_, index) => `Sentence ${index + 1}.`,
    ).join("\n")

    expect(preservesFullAssistantContent(content)).toBe(false)
    expect(visibleAssistantContent(content)).toContain("Sentence 1.")
    expect(visibleAssistantContent(content)).not.toContain("Sentence 8.")
  })
})
