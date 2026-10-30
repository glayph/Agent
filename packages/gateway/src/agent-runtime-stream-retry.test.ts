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

describe("monitor lifecycle event mapping", () => {
  it("emits run and plan metadata from real engine events", () => {
    const { sent, handle } = mapper()
    handle({ type: "run.started", runId: "r-monitor", goal: "Inspect a project" } as never)
    handle({
      type: "plan.created",
      runId: "r-monitor",
      plan: {
        id: "p1",
        goal: "Inspect a project",
        source: "llm",
        complexity: "multi_step",
        createdAt: "2026-10-30T00:00:00.000Z",
        steps: [
          { id: "s1", title: "Inspect", tool: "workspace_list", status: "pending" },
          { id: "s2", title: "Read files", tool: "file_read", dependsOn: ["s1"], status: "pending" },
        ],
      },
    } as never)

    expect(sent.find((item) => item.type === "node.run_start")?.payload).toMatchObject({
      run_id: "r-monitor",
      status: "running",
      objective: "Inspect a project",
    })
    expect(sent.find((item) => item.type === "node.plan")?.payload).toMatchObject({
      run_id: "r-monitor",
      total: 2,
      levels: 2,
    })
  })

  it("creates a redacted pending node, updates it while running, and completes it with the real result", () => {
    const { sent, handle } = mapper()
    const baseCall = {
      id: "call-1",
      name: "web_search",
      arguments: JSON.stringify({ query: "latest", apiKey: "sk-123456789012345678901234", password: "example-password" }),
      risk: "read",
      turn: 1,
      startedAt: "2026-10-30T00:00:00.000Z",
    }

    handle({ type: "tool.call", runId: "r-monitor", turn: 1, call: { ...baseCall, status: "requested" } } as never)
    expect(sent.filter((item) => item.type === "node.spawn")).toHaveLength(1)
    expect(sent.find((item) => item.type === "node.spawn")?.payload).toMatchObject({
      run_id: "r-monitor",
      node_id: "r-monitor:call-1",
      label: "web_search",
      level: 0,
      status: "pending",
      input: { query: "latest", apiKey: "[REDACTED]", password: "[REDACTED]" },
    })
    expect(sent.filter((item) => item.type === "node.update")).toHaveLength(0)

    handle({ type: "tool.call", runId: "r-monitor", turn: 1, call: { ...baseCall, status: "running" } } as never)
    expect(sent.find((item) => item.type === "node.update")?.payload).toMatchObject({
      node_id: "r-monitor:call-1",
      status: "running",
    })

    handle({
      type: "tool.call",
      runId: "r-monitor",
      turn: 1,
      call: { ...baseCall, status: "succeeded", durationMs: 42, resultPreview: "Found three results." },
    } as never)
    expect(sent.find((item) => item.type === "node.complete")?.payload).toMatchObject({
      node_id: "r-monitor:call-1",
      ok: true,
      duration_ms: 42,
      result_message: "Found three results.",
      output_preview: "Found three results.",
    })
    expect(sent.filter((item) => item.type === "node.spawn")).toHaveLength(1)
  })

  it("marks blocked, denied, cancelled, and failed calls as unsuccessful", () => {
    for (const status of ["blocked", "denied", "cancelled", "failed"]) {
      const { sent, handle } = mapper()
      const call = {
        id: `call-${status}`,
        name: "file_write",
        arguments: "{}",
        status,
        error: "Operation stopped",
        risk: "write",
        turn: 1,
        startedAt: "2026-10-30T00:00:00.000Z",
        durationMs: 9,
      }
      handle({ type: "tool.call", runId: "r-monitor", turn: 1, call: { ...call, status: "requested", error: undefined, durationMs: undefined } } as never)
      handle({ type: "tool.call", runId: "r-monitor", turn: 1, call } as never)
      expect(sent.find((item) => item.type === "node.complete")?.payload).toMatchObject({
        node_id: `r-monitor:call-${status}`,
        ok: false,
        result_message: "Operation stopped",
      })
    }
  })

  it("sends Monitor events even when optional chat tool feedback is disabled", () => {
    const sent: Sent[] = []
    const events = createWsEventMapper(
      (type, payload) => sent.push({ type, payload: payload as Record<string, unknown> }),
      "test-model",
      () => ({ enabled: false, separateMessages: false, maxArgsLength: 300 }),
    )
    events.handle({
      type: "tool.call",
      runId: "r-monitor",
      turn: 1,
      call: {
        id: "quiet-call",
        name: "workspace_list",
        arguments: "{}",
        status: "requested",
        risk: "read",
        turn: 1,
        startedAt: "2026-10-30T00:00:00.000Z",
      },
    } as never)

    expect(sent.some((item) => item.type === "node.spawn")).toBe(true)
    expect(sent.some((item) => item.type.startsWith("message."))).toBe(false)
  })
})
