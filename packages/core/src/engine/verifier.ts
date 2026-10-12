import type { EngineLLMClient, EngineMessage } from "./types.js";
import { errorMessage, truncate } from "./util.js";

export interface AnswerVerdict {
  /** True when the draft answer needs no change. */
  ok: boolean;
  /** Concrete problems the verifier found; empty when ok. */
  issues: string[];
}

export interface VerifyAnswerInput {
  llm: EngineLLMClient;
  goal: string;
  answer: string;
  /** Tool results gathered during the run, newest last. */
  messages: EngineMessage[];
  signal?: AbortSignal;
  maxEvidenceMessages?: number;
  maxEvidenceChars?: number;
  onError?: (reason: string) => void;
}

/** The newest tool outputs, trimmed, so the verifier can check claims against real evidence. */
export function buildEvidence(
  messages: EngineMessage[],
  maxMessages = 10,
  maxChars = 700,
): string {
  const tools = messages.filter((message) => message.role === "tool");
  return tools
    .slice(-maxMessages)
    .map((message) => `[${message.name ?? "tool"}] ${truncate(String(message.content ?? ""), maxChars)}`)
    .join("\n");
}

/** Tolerant parser: the model may wrap its JSON in prose or code fences. */
export function parseVerdict(text: string): AnswerVerdict | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const value = parsed as { ok?: unknown; issues?: unknown };
  if (typeof value?.ok !== "boolean") return null;
  const issues = Array.isArray(value.issues)
    ? value.issues
        .filter((issue): issue is string => typeof issue === "string" && issue.trim().length > 0)
        .map((issue) => issue.trim().slice(0, 300))
        .slice(0, 5)
    : [];
  // A "not ok" verdict without a concrete issue gives the model nothing to fix.
  if (!value.ok && issues.length === 0) return { ok: true, issues: [] };
  return { ok: value.ok, issues: value.ok ? [] : issues };
}

/**
 * Asks the model to check its own draft against the request and the evidence.
 * Understanding is entirely the model's job: no wording of the request or the
 * answer is inspected here. Returns null when the check itself could not run
 * (the draft is then accepted as-is; verification never blocks an answer).
 */
export async function verifyAnswer(input: VerifyAnswerInput): Promise<AnswerVerdict | null> {
  try {
    const evidence = buildEvidence(input.messages, input.maxEvidenceMessages, input.maxEvidenceChars);
    const response = await input.llm.complete(
      [
        {
          role: "system",
          content:
            "You are the verification module of an autonomous agent. Check a draft answer against the user's request and the tool evidence. " +
            "Report only concrete problems: a claim the evidence does not support, a tool failure presented as success, a part of the request that was ignored, or a contradiction with the evidence. " +
            "Do not nitpick style, length or wording. If the draft is accurate and complete, it is ok. " +
            'Reply with ONLY a JSON object: {"ok":true|false,"issues":["short, specific problem"]}. Use an empty issues list when ok.',
        },
        {
          role: "user",
          content: [
            `User request:\n${truncate(input.goal, 2_000)}`,
            `Tool evidence (newest last):\n${evidence || "(no tool output)"}`,
            `Draft answer:\n${truncate(input.answer, 4_000)}`,
          ].join("\n\n"),
        },
      ],
      { json: true, toolChoice: "none", temperature: 0, signal: input.signal },
    );
    const text = response.choices?.[0]?.message?.content;
    const verdict = parseVerdict(typeof text === "string" ? text : "");
    if (!verdict) input.onError?.("The verifier reply was not valid JSON.");
    return verdict;
  } catch (error) {
    if (input.signal?.aborted) throw error;
    input.onError?.(errorMessage(error));
    return null;
  }
}
