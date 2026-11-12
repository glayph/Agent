import { describe, expect, it, vi } from "vitest"
import { detectStopIntent } from "./chat-turn-runner.js"

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
