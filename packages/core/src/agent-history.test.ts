import type { ChatMessage } from "@miki/config";
import {
  buildConversationRecallReply,
  selectAgentPromptHistory,
} from "./agent-history.js";

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

  it("retains recent conversation for continuity questions", () => {
    const selected = selectAgentPromptHistory(
      [
        ...history,
        { role: "assistant", content: "I opened OpenHuman." },
        { role: "user", content: "কিছুক্ষণ আগে তুমাকে কি বলেছিলাম?" },
      ],
      "simple",
      "bounded",
      20,
    );

    expect(selected.map((message) => message.content)).toEqual([
      "old research task",
      "old task claim",
      "stale browser failure",
      "শুধু লিখো: ঢাকা",
      "I opened OpenHuman.",
      "কিছুক্ষণ আগে তুমাকে কি বলেছিলাম?",
    ]);
    expect(selected.some((message) => message.role === "tool")).toBe(false);
  });

  it("answers explicit recall questions from persisted messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "তুমি কি file folder তৈরি করতে পারো?" },
      { role: "assistant", content: "হ্যাঁ, পারি।" },
      { role: "user", content: "কিছুক্ষণ আগে তুমাকে কি বলেছিলাম?" },
    ];
    expect(buildConversationRecallReply(messages, messages.at(-1)!.content)).toBe(
      "আপনি আগে বলেছিলেন:\n- তুমি কি file folder তৈরি করতে পারো?",
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
