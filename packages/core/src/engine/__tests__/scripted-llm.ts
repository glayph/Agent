import type { LLMResponse } from "@miki/config";
import type {
  EngineLLMClient,
  EngineMessage,
  LLMCompletionOptions,
} from "../types.js";

export type ScriptedReply =
  | { text: string }
  | { calls: Array<{ name: string; args?: unknown; id?: string; rawArgs?: string }>; text?: string }
  | { error: string }
  | ((messages: EngineMessage[], options?: LLMCompletionOptions) => PlainReply | Promise<PlainReply>);

type PlainReply =
  | { text: string }
  | { calls: Array<{ name: string; args?: unknown; id?: string; rawArgs?: string }>; text?: string }
  | { error: string };

/** LLM stub that answers from a script and records every request it receives. */
export function scriptedLLM(replies: ScriptedReply[], model = "test-model") {
  const requests: Array<{ messages: EngineMessage[]; options?: LLMCompletionOptions }> = [];
  let index = 0;
  const client: EngineLLMClient = {
    model,
    async complete(messages, options) {
      requests.push({ messages: structuredClone(messages), options });
      // Keep completion-classifier calls orthogonal to the scripted main-model
      // sequence. This is a deterministic test double, not production routing.
      if (options?.json === true && String(messages[0]?.content || "").includes("You classify whether the agent has completed")) {
        const payload = JSON.parse(String(messages[1]?.content || "{}")) as { assistant_response?: string; available_tools?: string[] }
        const draft = String(payload.assistant_response || "")
        const names = Array.isArray(payload.available_tools) ? payload.available_tools : []
        const pending = draft.length > 0 && (draft.includes("I will call") || draft.includes("I will ") || draft.includes("First I will") || names.some((name) => draft.includes(name)))
        return { choices: [{ message: { role: "assistant", content: JSON.stringify({ needs_tool_execution: pending }) } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
      }
      const scripted = replies[Math.min(index, replies.length - 1)];
      index += 1;
      const reply = typeof scripted === "function" ? await scripted(messages, options) : scripted;
      if ("error" in reply) throw new Error(reply.error);
      const response: LLMResponse = {
        choices: [
          {
            message:
              "calls" in reply
                ? {
                    role: "assistant",
                    content: reply.text ?? null,
                    tool_calls: reply.calls.map((call, i) => ({
                      id: call.id ?? `call_${index}_${i}`,
                      type: "function" as const,
                      function: {
                        name: call.name,
                        arguments: call.rawArgs ?? JSON.stringify(call.args ?? {}),
                      },
                    })),
                  }
                : { role: "assistant", content: reply.text },
            finish_reason: "calls" in reply ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      return response;
    },
  };
  return { client, requests };
}
