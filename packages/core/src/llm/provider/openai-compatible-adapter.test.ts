import { normalizeToolMessageSequence } from "./message-normalizer.js";

function message(input: Record<string, unknown>) {
  return input as never;
}

describe("normalizeToolMessageSequence", () => {
  it("preserves a valid assistant tool call followed by its result", () => {
    const result = normalizeToolMessageSequence([
      message({
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1" }],
      }),
      message({ role: "tool", tool_call_id: "call-1", content: "ok" }),
    ]);

    expect(result.map((item) => item.role)).toEqual(["assistant", "tool"]);
    expect(result[1]?.tool_call_id).toBe("call-1");
  });

  it("converts an orphan tool result into safe user context", () => {
    const result = normalizeToolMessageSequence([
      message({ role: "tool", tool_call_id: "orphan-1", content: "result" }),
    ]);

    expect(result).toEqual([
      { role: "user", content: "[Tool result orphan-1] result" },
    ]);
  });

  it("handles multiple calls and only normalizes unmatched results", () => {
    const result = normalizeToolMessageSequence([
      message({
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-a" }, { id: "call-b" }],
      }),
      message({ role: "tool", tool_call_id: "call-b", content: "b" }),
      message({ role: "tool", tool_call_id: "unknown", content: "u" }),
      message({ role: "tool", tool_call_id: "call-a", content: "a" }),
    ]);

    expect(result.map((item) => item.role)).toEqual([
      "assistant",
      "tool",
      "user",
      "tool",
    ]);
  });
});
