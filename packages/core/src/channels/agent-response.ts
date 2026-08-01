import type { AgentOrchestrator } from "../agent.js";

export function extractAgentChunkContent(chunk: string): string {
  try {
    const parsed = JSON.parse(chunk) as { type?: string; content?: unknown };
    if (
      parsed.type === "stream_chunk" ||
      parsed.type === "error" ||
      parsed.type === "final"
    ) {
      return typeof parsed.content === "string" ? parsed.content : "";
    }
  } catch {
    return chunk;
  }
  return "";
}

export async function collectAgentResponse(
  orchestrator: AgentOrchestrator,
  sessionId: string,
  message: string,
  maxChars = 12000,
): Promise<string> {
  let response = "";
  for await (const chunk of orchestrator.runAgentLoop(sessionId, message)) {
    const content = extractAgentChunkContent(chunk);
    if (!content) continue;
    response += content;
    if (response.length >= maxChars) {
      response = `${response.slice(0, maxChars)}\n\n[Response truncated]`;
      break;
    }
  }
  return response.trim() || "No response was generated.";
}

export function splitOutboundMessage(
  text: string,
  maxLength: number,
): string[] {
  if (text.length <= maxLength) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let slice = remaining.slice(0, maxLength);
    const breakAt = Math.max(
      slice.lastIndexOf("\n\n"),
      slice.lastIndexOf("\n"),
      slice.lastIndexOf(". "),
      slice.lastIndexOf(" "),
    );
    if (breakAt > Math.floor(maxLength * 0.5)) {
      slice = slice.slice(0, breakAt).trimEnd();
    }
    parts.push(slice);
    remaining = remaining.slice(slice.length).trimStart();
  }
  return parts;
}
