import { MessageRouter } from "./message-router.js"
import type { EngineLLMClient } from "./engine/types.js"

function client(responses: string[]): EngineLLMClient {
  let index = 0
  return {
    model: "router-test",
    complete: jest.fn(async () => ({
      choices: [{ message: { content: responses[Math.min(index++, responses.length - 1)] } }],
    })) as EngineLLMClient["complete"],
  }
}

describe("MessageRouter", () => {
  it("returns the semantic model's FAST_CHAT decision", async () => {
    const llm = client(['{"mode":"FAST_CHAT","confidence":0.94,"reason":"direct conversation"}'])
    const router = new MessageRouter({ llmFor: () => llm })
    await expect(router.route([{ role: "user", content: "How are you?" }])).resolves.toMatchObject({ mode: "FAST_CHAT", confidence: 0.94 })
    expect(llm.complete).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ json: true, maxCompletionTokens: 160 }))
  })

  it("fails closed to FULL_AGENT for invalid or unavailable classification", async () => {
    const invalid = new MessageRouter({ llmFor: () => client(["not-json"]) })
    await expect(invalid.route([{ role: "user", content: "ambiguous request" }])).resolves.toMatchObject({ mode: "FULL_AGENT", confidence: 0 })

    const unavailable = new MessageRouter({ llmFor: () => undefined })
    await expect(unavailable.route([{ role: "user", content: "anything" }])).resolves.toMatchObject({ mode: "FULL_AGENT", confidence: 0 })
  })

  it("returns fast conversational output and preserves the semantic escape flag", async () => {
    const llm = client(['{"answer":"A concise answer","requires_full_agent":false}'])
    const router = new MessageRouter({ llmFor: () => llm })
    await expect(router.fastChat([{ role: "user", content: "Explain this simply" }])).resolves.toMatchObject({ answer: "A concise answer", requiresFullAgent: false })

    const escape = new MessageRouter({ llmFor: () => client(['{"answer":"I need more context","requires_full_agent":true}']) })
    await expect(escape.fastChat([{ role: "user", content: "Please handle this" }])).resolves.toMatchObject({ requiresFullAgent: true })
  })

  it("escalates malformed fast responses instead of presenting an unsafe claim", async () => {
    const router = new MessageRouter({ llmFor: () => client(["plain text without the required envelope"]) })
    await expect(router.fastChat([{ role: "user", content: "request" }])).resolves.toMatchObject({ answer: "", requiresFullAgent: true })
  })
})
