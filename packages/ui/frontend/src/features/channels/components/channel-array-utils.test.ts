import { describe, expect, it } from "vitest"

import {
  mergeUniqueStringItems,
  normalizeAllowFromValues,
  parseAllowFromInput,
  parseConservativeStringListInput,
  serializeStringArrayForSubmit,
} from "./channel-array-utils"

describe("channel array utilities", () => {
  it("parses allow-from input with hidden-character stripping and de-duplication", () => {
    expect(
      parseAllowFromInput(
        "  alice,\u200bbob\nalice;carol\u3001dan\uFF1Berin  ",
      ),
    ).toEqual(["alice", "bob", "carol", "dan", "erin"])
  })

  it("parses conservative lists without semicolon splitting", () => {
    expect(parseConservativeStringListInput("alpha, beta\nalpha;gamma")).toEqual(
      ["alpha", "beta", "alpha;gamma"],
    )
  })

  it("normalizes persisted allow-from values", () => {
    expect(normalizeAllowFromValues([" one ", "\u200btwo", "one", 3])).toEqual([
      "one",
      "two",
    ])
  })

  it("merges unique string items while preserving first-seen order", () => {
    expect(mergeUniqueStringItems(["alpha", " beta "], ["beta", "gamma"])).toEqual(
      ["alpha", "beta", "gamma"],
    )
  })

  it("serializes arrays as newline-delimited strings and preserves non-arrays", () => {
    expect(serializeStringArrayForSubmit([" a ", "b", "a"])).toBe("a\nb")
    expect(serializeStringArrayForSubmit("unchanged")).toBe("unchanged")
  })
})
