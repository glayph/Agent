import { describe, expect, it, vi } from "vitest"
import { classifySteerMessage, detectStopIntent } from "./chat-turn-runner.js"

function llmReplying(content: string) {
  const complete = vi.fn(async () => ({ choices: [{ message: { content } }] }))
  return { complete }
}

describe("detectStopIntent", () => {
  it("never treats a question as a stop request, so the running work keeps going", async () => {
    const llm = llmReplying('{"stop": true}')
    await expect(detectStopIntent(llm, "তুমি কী করছো?", "tool")).resolves.toBe(false)
    await expect(detectStopIntent(llm, "why did you stop earlier?", "tool")).resolves.toBe(false)
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it("stops only when the model returns an explicit stop", async () => {
    await expect(detectStopIntent(llmReplying('{"stop": true}'), "cancel the task now", "tool")).resolves.toBe(true)
    await expect(detectStopIntent(llmReplying('{"stop": false}'), "also add a summary", "model")).resolves.toBe(false)
  })

  it("accepts a fenced JSON answer", async () => {
    await expect(detectStopIntent(llmReplying('```json\n{"stop": true}\n```'), "stop it", "tool")).resolves.toBe(true)
  })

  it("defaults to not stopping on malformed output or provider failure", async () => {
    await expect(detectStopIntent(llmReplying("yes"), "stop it", "tool")).resolves.toBe(false)
    const failing = { complete: vi.fn(async () => { throw new Error("provider down") }) }
    await expect(detectStopIntent(failing, "stop it", "tool")).resolves.toBe(false)
  })
})

describe("classifySteerMessage", () => {
  it("returns added steps for a task update that is not a stop", async () => {
    const llm = llmReplying('{"stop": false, "addSteps": ["Add a summary", "Send it by email"]}');
    await expect(classifySteerMessage(llm, "সাথে একটা summary-ও লিখবে আর email করবে", "tool")).resolves.toEqual({
      stop: false,
      addSteps: ["Add a summary", "Send it by email"],
    });
  });

  it("never adds steps to a question", async () => {
    const llm = llmReplying('{"stop": false, "addSteps": ["Add a summary"]}');
    await expect(classifySteerMessage(llm, "summary-ও কি লিখবে?", "tool")).resolves.toEqual({ stop: false, addSteps: [] });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("drops added steps when the model says stop", async () => {
    const llm = llmReplying('{"stop": true, "addSteps": ["Something"]}');
    await expect(classifySteerMessage(llm, "cancel it all", "tool")).resolves.toEqual({ stop: true, addSteps: [] });
  });

  it("sanitizes model output: non-strings and oversized lists are bounded", async () => {
    const llm = llmReplying(JSON.stringify({ stop: false, addSteps: [1, "ok", "  ", "a", "b", "c", "d", "e", "f"] }));
    const result = await classifySteerMessage(llm, "do more", "tool");
    expect(result.addSteps).toEqual(["ok", "a", "b", "c", "d"]);
  });

  it("falls back to no change on malformed output", async () => {
    await expect(classifySteerMessage(llmReplying("not json"), "do more", "tool")).resolves.toEqual({ stop: false, addSteps: [] });
  });
});
