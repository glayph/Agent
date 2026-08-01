import { describe, expect, it } from "vitest"

import {
  extractCodeBlockFromPreNode,
  extractCodeBlockLanguage,
  splitCodeIntoLines,
  stripSingleTrailingLineBreak,
  toClassNameTokens,
  trimTrailingEmptyStringLine,
} from "./message-code-block.utils"

describe("message code block utilities", () => {
  it("normalizes className values into tokens", () => {
    expect(toClassNameTokens(" language-ts  highlighted ")).toEqual([
      "language-ts",
      "highlighted",
    ])
    expect(toClassNameTokens(["language-js", "", 2, "token"])).toEqual([
      "language-js",
      "token",
    ])
    expect(toClassNameTokens(undefined)).toEqual([])
  })

  it("extracts markdown code block language tokens", () => {
    expect(extractCodeBlockLanguage("hljs language-json")).toBe("json")
    expect(extractCodeBlockLanguage(["foo", "language-bash"])).toBe("bash")
    expect(extractCodeBlockLanguage("language-")).toBeNull()
  })

  it("strips only one trailing line break", () => {
    expect(stripSingleTrailingLineBreak("one\n")).toBe("one")
    expect(stripSingleTrailingLineBreak("one\n\n")).toBe("one\n")
    expect(stripSingleTrailingLineBreak("one")).toBe("one")
  })

  it("extracts code and language from nested markdown pre nodes", () => {
    expect(
      extractCodeBlockFromPreNode({
        tagName: "pre",
        children: [
          {
            tagName: "code",
            properties: { className: "language-ts" },
            children: [
              { type: "text", value: "const value = 1\n" },
              { type: "text", value: "value\n" },
            ],
          },
        ],
      }),
    ).toEqual({
      code: "const value = 1\nvalue",
      language: "ts",
    })
  })

  it("splits code and trims one trailing empty display line", () => {
    expect(splitCodeIntoLines("a\nb\n")).toEqual(["a", "b", ""])
    expect(trimTrailingEmptyStringLine(["a", "b", ""])).toEqual(["a", "b"])
    expect(trimTrailingEmptyStringLine([""])).toEqual([""])
  })

  it("keeps markup-like code as inert text", () => {
    expect(splitCodeIntoLines("<img src=x onerror=alert(1)>\ntext")).toEqual([
      "<img src=x onerror=alert(1)>",
      "text",
    ])
  })
})
