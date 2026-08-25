import type { ChatMessage } from "@miki/config";
import { selectAgentPromptHistory } from "./agent-history.js";

describe("selectAgentPromptHistory", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "old research task" },
    { role: "assistant", content: "old task claim" },
    { role: "tool", content: "Error calling LLM: stale tool failure" },
    { role: "assistant", content: "stale browser failure" },
    { role: "user", content: "শুধু লিখো: ঢাকা" },
  ];

  it("sends only the current user turn for simple local prompts", () => {
    const selected = selectAgentPromptHistory(history, "simple", "bounded", 20);

    expect(selected).toEqual([{ role: "user", content: "শুধু লিখো: ঢাকা" }]);
    expect(selected.some((message) => message.role === "tool")).toBe(false);
    expect(selected.map((message) => message.content).join(" ")).not.toContain(
      "stale",
    );
  });

  it("keeps bounded tool history for standard and complex workflows", () => {
    const selected = selectAgentPromptHistory(history, "complex", "bounded", 3);

    expect(selected).toHaveLength(3);
    expect(selected.some((message) => message.role === "tool")).toBe(true);
    expect(selected.at(-1)?.content).toBe("শুধু লিখো: ঢাকা");
  });

  it("honors history off for every complexity", () => {
    expect(selectAgentPromptHistory(history, "simple", "off", 20)).toEqual([]);
    expect(selectAgentPromptHistory(history, "complex", "off", 20)).toEqual([]);
  });
});
