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
