import { describe, expect, it } from "vitest"

import {
  DEFAULT_ASSISTANT_DETAIL_VISIBILITY,
  resolveAssistantDetailVisibilityPreference,
  shouldShowAssistantMessage,
} from "./detail-visibility"

describe("shouldShowAssistantMessage", () => {
  describe("normal assistant content", () => {
    it("is always shown, regardless of visibility setting", () => {
      for (const visibility of ["none", "thought", "tool_calls", "all"] as const) {
        expect(shouldShowAssistantMessage(visibility, "normal")).toBe(true)
        expect(shouldShowAssistantMessage(visibility, undefined)).toBe(true)
      }
    })

    it("is shown even when a message happens to carry inspectorOnly (kind takes precedence for non-thought/tool_calls kinds is not applicable, but normal should never be hidden)", () => {
      // Normal/error content should never be suppressed by the chat UI —
      // inspectorOnly is only meaningful for thought/tool_calls kinds.
      expect(shouldShowAssistantMessage("all", "normal", false)).toBe(true)
    })
  })

  describe("action_update content", () => {
    it("is never shown in the chat UI, regardless of visibility", () => {
      for (const visibility of ["none", "thought", "tool_calls", "all"] as const) {
        expect(shouldShowAssistantMessage(visibility, "action_update")).toBe(
          false,
        )
      }
    })
  })

  describe("thought content (chat-eligible, i.e. not inspector_only)", () => {
    it("is hidden when visibility is 'none'", () => {
      expect(shouldShowAssistantMessage("none", "thought")).toBe(false)
    })

    it("is shown when visibility is 'thought'", () => {
      expect(shouldShowAssistantMessage("thought", "thought")).toBe(true)
    })

    it("is hidden when visibility is 'tool_calls'", () => {
      expect(shouldShowAssistantMessage("tool_calls", "thought")).toBe(false)
    })

    it("is shown when visibility is 'all'", () => {
      expect(shouldShowAssistantMessage("all", "thought")).toBe(true)
    })
  })

  describe("tool_calls content (chat-eligible, i.e. not inspector_only)", () => {
    it("is hidden when visibility is 'none'", () => {
      expect(shouldShowAssistantMessage("none", "tool_calls")).toBe(false)
    })

    it("is hidden when visibility is 'thought'", () => {
      expect(shouldShowAssistantMessage("thought", "tool_calls")).toBe(false)
    })

    it("is shown when visibility is 'tool_calls'", () => {
      expect(shouldShowAssistantMessage("tool_calls", "tool_calls")).toBe(
        true,
      )
    })

    it("is shown when visibility is 'all'", () => {
      expect(shouldShowAssistantMessage("all", "tool_calls")).toBe(true)
    })
  })

  describe("inspector_only regression coverage", () => {
    // Regression test: the backend marks certain thought/tool_calls messages
    // as inspector_only (see packages/core/src/api/index.ts,
    // _sendInspectorThought). These must NEVER render in the chat bubble UI,
    // no matter what the user's visibility preference is set to — they
    // should only ever be visible in the Inspector panel. Previously,
    // shouldShowAssistantMessage ignored this flag entirely and only
    // consulted `kind`, so enabling "Show both" would have leaked
    // inspector-only reasoning traces into the main chat UI.
    it("hides an inspector_only thought message even when visibility is 'all'", () => {
      expect(shouldShowAssistantMessage("all", "thought", true)).toBe(false)
    })

    it("hides an inspector_only thought message even when visibility is 'thought'", () => {
      expect(shouldShowAssistantMessage("thought", "thought", true)).toBe(
        false,
      )
    })

    it("hides an inspector_only tool_calls message even when visibility is 'all'", () => {
      expect(shouldShowAssistantMessage("all", "tool_calls", true)).toBe(
        false,
      )
    })

    it("still hides a non-inspector_only thought message under 'none' (baseline, unaffected by the fix)", () => {
      expect(shouldShowAssistantMessage("none", "thought", false)).toBe(false)
    })

    it("still shows a non-inspector_only thought message under 'all' (baseline, unaffected by the fix)", () => {
      expect(shouldShowAssistantMessage("all", "thought", false)).toBe(true)
    })

    it("treats an undefined inspectorOnly the same as false", () => {
      expect(shouldShowAssistantMessage("all", "thought", undefined)).toBe(
        true,
      )
    })
  })
})

describe("resolveAssistantDetailVisibilityPreference", () => {
  it("falls back to the default when nothing is stored", () => {
    const decision = resolveAssistantDetailVisibilityPreference(null, null)
    expect(decision.value).toBe(DEFAULT_ASSISTANT_DETAIL_VISIBILITY)
    expect(decision.value).toBe("none")
  })

  it("reads a valid stored preference", () => {
    const decision = resolveAssistantDetailVisibilityPreference(
      JSON.stringify("all"),
      null,
    )
    expect(decision.value).toBe("all")
    expect(decision.newValueAction).toBe("keep")
  })

  it("migrates the legacy boolean flag to 'all' when true", () => {
    const decision = resolveAssistantDetailVisibilityPreference(
      null,
      JSON.stringify(true),
    )
    expect(decision.value).toBe("all")
    expect(decision.removeLegacyValue).toBe(true)
  })

  it("migrates the legacy boolean flag to 'none' when false", () => {
    const decision = resolveAssistantDetailVisibilityPreference(
      null,
      JSON.stringify(false),
    )
    expect(decision.value).toBe("none")
  })
})
