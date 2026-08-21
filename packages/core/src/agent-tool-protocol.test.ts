import { detectTextToolCall, parseToolArguments } from "./tool-protocol.js";

describe("strict tool protocol", () => {
  it("identifies native-tool JSON emitted as plain text without executing it", () => {
    expect(
      detectTextToolCall("```json\n{\"name\":\"file_write\",\"arguments\":{}}\n```"),
    ).toEqual({ toolName: "file_write" });
    expect(detectTextToolCall("I wrote the file successfully.")).toBeNull();
  });

  it("rejects malformed native tool arguments before the registry is called", () => {
    const parsed = parseToolArguments("file_write", "{not-json");
    expect(parsed.toolArgs).toEqual({});
    expect(parsed.parseError).toContain("not valid JSON");
  });

  it("rejects scalar arguments instead of wrapping them into executable input", () => {
    const parsed = parseToolArguments("file_write", JSON.stringify("write this"));
    expect(parsed.toolArgs).toEqual({});
    expect(parsed.parseError).toContain("JSON object");
  });
});
