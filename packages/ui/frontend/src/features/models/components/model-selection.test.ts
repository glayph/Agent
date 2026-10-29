import { describe, expect, it } from "vitest"

import {
  createEmptyModelSelection,
  deduplicateModelIds,
  planFetchedModelFill,
  retainUnsuccessfulModelIds,
  toggleVisibleModelSelection,
} from "./model-selection"

describe("fetched model selection", () => {
  it("starts and resets with no model selected", () => {
    expect([...createEmptyModelSelection()]).toEqual([])
    expect([...createEmptyModelSelection()]).toEqual([])
    expect(deduplicateModelIds(["gpt-4o", "gpt-4o", " claude-3 ", ""])).toEqual([
      "gpt-4o",
      "claude-3",
    ])
  })

  it("selects only visible items without replacing selections outside the filter", () => {
    const selected = toggleVisibleModelSelection(["outside-filter"], ["gpt-4o", "claude-3"])
    expect([...selected]).toEqual(["outside-filter", "gpt-4o", "claude-3"])
  })

  it("clears only visible selectable items when all are selected", () => {
    const selected = toggleVisibleModelSelection(
      ["gpt-4o", "claude-3", "outside-filter"],
      ["gpt-4o", "claude-3"],
    )
    expect([...selected]).toEqual(["outside-filter"])
  })

  it("never selects or toggles model IDs already added", () => {
    const selected = toggleVisibleModelSelection(
      [],
      ["gpt-4o", "claude-3"],
      ["gpt-4o"],
    )
    expect([...selected]).toEqual(["claude-3"])
  })

  it("keeps only unsuccessful IDs for retry after a partial save", () => {
    expect(retainUnsuccessfulModelIds(["a", "b", "c"], ["a", "c"])).toEqual(["b"])
  })

  it("fills the Model field when exactly one model is chosen", () => {
    expect(planFetchedModelFill(["gpt-4o", " gpt-4o "])).toEqual({
      suggestions: ["gpt-4o"],
      chips: [],
      modelField: "gpt-4o",
    })
  })

  it("turns two or more chosen models into chips and clears the Model field", () => {
    expect(planFetchedModelFill(["a", "b", "a"])).toEqual({
      suggestions: ["a", "b"],
      chips: ["a", "b"],
      modelField: "",
    })
  })

  it("leaves the form untouched when nothing is chosen", () => {
    expect(planFetchedModelFill([])).toEqual({
      suggestions: [],
      chips: [],
      modelField: null,
    })
  })
})
