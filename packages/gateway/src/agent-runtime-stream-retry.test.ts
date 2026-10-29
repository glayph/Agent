import { describe, expect, it } from "vitest";
import { createWsEventMapper } from "./agent-runtime.js";

type Sent = { type: string; payload: Record<string, unknown> };

function mapper() {
  const sent: Sent[] = [];
  const events = createWsEventMapper((type, payload) => sent.push({ type, payload: payload as Record<string, unknown> }), "test-model");
  return { sent, handle: events.handle };
}

/** Text that is visible in chat for a streamed message after applying create/delta/update/delete in order. */
function visibleText(sent: Sent[]): string {
  const messages = new Map<string, string>();
  for (const { type, payload } of sent) {
    const id = String(payload.message_id ?? "");
    if (type === "message.create") messages.set(id, String(payload.content ?? ""));
    else if (type === "message.delta") messages.set(id, (messages.get(id) ?? "") + String(payload.delta ?? ""));
    else if (type === "message.update") messages.set(id, String(payload.content ?? ""));
    else if (type === "message.delete") messages.delete(id);
  }
  return [...messages.values()].join("|");
}

describe("streamed text after an in-place model retry", () => {
  it("does not show the partly streamed text again when the same turn is retried", () => {
    const { sent, handle } = mapper();
    handle({ type: "run.started", runId: "r1" } as never);
    handle({ type: "message.delta", runId: "r1", turn: 1, delta: "Hello wor" });
    handle({ type: "model.retrying", runId: "r1", turn: 1, retry: 1, delayMs: 1000, reason: "network" });
    // The retried call streams the whole answer from the beginning.
    handle({ type: "message.delta", runId: "r1", turn: 1, delta: "Hello world" });
    expect(visibleText(sent)).toBe("Hello world");
    handle({ type: "message.final", runId: "r1", content: "Hello world" });
    expect(visibleText(sent)).toBe("Hello world");
  });

  it("also retracts partial text when the run fails over to another model", () => {
    const { sent, handle } = mapper();
    handle({ type: "message.delta", runId: "r1", turn: 1, delta: "Partial" });
    handle({ type: "model.fallback", runId: "r1", turn: 1, from: "a", to: "b", reason: "503" });
    handle({ type: "message.delta", runId: "r1", turn: 1, delta: "Full answer" });
    expect(visibleText(sent)).toBe("Full answer");
  });

  it("leaves a retry with nothing streamed yet untouched", () => {
    const { sent, handle } = mapper();
    handle({ type: "model.retrying", runId: "r1", turn: 1, retry: 1, delayMs: 1000, reason: "network" });
    expect(sent.filter((item) => item.type === "message.delete")).toHaveLength(0);
  });
});
