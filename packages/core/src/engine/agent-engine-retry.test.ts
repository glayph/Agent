import { AgentEngine } from "./agent-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { scriptedLLM } from "./__tests__/scripted-llm.js";
import type { EngineEvent, EngineLLMClient, EngineMessage, EngineTool } from "./types.js";

const user = (content: string): EngineMessage[] => [{ role: "user", content }];
const unavailable = () => Object.assign(new Error("Service unavailable"), { status: 503 });
const fast = { baseDelayMs: 5, maxDelayMs: 10 };

function reply(text: string | null, calls?: Array<{ name: string; id: string }>) {
  return {
    choices: [{
      message: {
        role: "assistant" as const,
        content: text,
        ...(calls ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: "{}" } })) } : {}),
      },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/** A model that fails with 503 for the listed call numbers (1-based) and otherwise returns the next scripted reply. */
function flaky(failOnCalls: number[], replies: Array<ReturnType<typeof reply>>) {
  let calls = 0;
  let next = 0;
  const client: EngineLLMClient = {
    model: "flaky-model",
    async complete() {
      calls += 1;
      if (failOnCalls.includes(calls)) throw unavailable();
      return replies[Math.min(next++, replies.length - 1)] as never;
    },
  };
  return { client, calls: () => calls };
}

describe("provider failure taxonomy", () => {
  it("keeps unsupported-model HTTP 400 distinct from entitlement", async () => {
    const client: EngineLLMClient = {
      model: "unsupported-model",
      async complete() {
        throw Object.assign(new Error("Provider rejected the selected model."), {
          status: 400,
          diagnostic: { providerCode: "model_not_found" },
        });
      },
    };
    const engine = new AgentEngine({ llm: client, tools: new ToolRegistry() });
    const result = await engine.run({ history: user("use this model"), retryTransient: { maxRetries: 0 } });
    expect(result.status).toBe("failed");
    expect(result.failureKind).toBe("model_not_found");
  });

  it("preserves rate-limit, provider-5xx, and network categories after bounded retries", async () => {
    const cases: Array<{ error: Error; expected: string }> = [
      { error: Object.assign(new Error("Provider rate limit exceeded."), { name: "LLMRateLimitError", status: 429 }), expected: "rate_limit" },
      { error: Object.assign(new Error("Provider temporarily unavailable."), { status: 503, retryable: true }), expected: "provider_unavailable" },
      { error: Object.assign(new Error("fetch failed"), { retryable: true, code: "ECONNRESET" }), expected: "network" },
    ];
    for (const item of cases) {
      const client: EngineLLMClient = { model: "transient-model", async complete() { throw item.error; } };
      const engine = new AgentEngine({ llm: client, tools: new ToolRegistry() });
      const result = await engine.run({ history: user("try again"), retryTransient: { maxRetries: 0 } });
      expect(result.failureKind).toBe(item.expected);
      expect(result.status).toBe("failed");
    }
  });
});

describe("in-place retry of transient model failures", () => {
  it("preserves the explicit interactive goal and correlates run lifecycle events", async () => {
    const base = scriptedLLM([{ text: "Answered the explicit goal." }]);
    const client: EngineLLMClient = { ...base.client, providerId: "gemini" };
    const engine = new AgentEngine({ llm: client, tools: new ToolRegistry() });
    const events: EngineEvent[] = [];
    const result = await engine.run({
      runId: "run-interactive-goal",
      sessionId: "context-1",
      userMessageId: "message-1",
      goal: "আমার জন্য একটি পরিকল্পনা তৈরি করো",
      history: [{ role: "user", content: "stale earlier request" }, { role: "system", content: "carryover note" }],
      plan: false,
      allowTools: false,
      onEvent: (event) => events.push(event),
    });
    expect(result).toMatchObject({
      goal: "আমার জন্য একটি পরিকল্পনা তৈরি করো",
      sessionId: "context-1",
      userMessageId: "message-1",
      providerId: "gemini",
      status: "completed",
    });
    expect(events.find((event) => event.type === "run.started")).toMatchObject({
      runId: "run-interactive-goal",
      sessionId: "context-1",
      userMessageId: "message-1",
      providerId: "gemini",
      goal: "আমার জন্য একটি পরিকল্পনা তৈরি করো",
    });
    expect(events.find((event) => event.type === "run.finished")).toMatchObject({
      runId: "run-interactive-goal",
      userMessageId: "message-1",
      providerId: "gemini",
      status: "completed",
    });
  });

  it("fails the run when retryTransient is not requested (previous behaviour)", async () => {
    const llm = flaky([1], [reply("ok")]);
    const engine = new AgentEngine({ llm: llm.client, tools: new ToolRegistry() });
    const result = await engine.run({ history: user("hi") });
    expect(result.status).toBe("failed");
    expect(llm.calls()).toBe(1);
  });

  it("waits and retries the same call until the model answers", async () => {
    const llm = flaky([1, 2, 3], [reply("back online")]);
    const engine = new AgentEngine({ llm: llm.client, tools: new ToolRegistry() });
    const events: EngineEvent[] = [];
    const result = await engine.run({ history: user("hi"), retryTransient: fast, onEvent: (event) => events.push(event) });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("back online");
    expect(llm.calls()).toBe(4);
    const retrying = events.filter((event) => event.type === "model.retrying");
    expect(retrying).toHaveLength(3);
    expect(retrying.map((event) => (event as { retry: number }).retry)).toEqual([1, 2, 3]);
    expect(Math.max(...retrying.map((event) => (event as { delayMs: number }).delayMs))).toBeLessThanOrEqual(10);
    expect(events.filter((event) => event.type === "model.resumed")).toEqual([expect.objectContaining({ retries: 3 })]);
  });

  it("does not impose a small default retry ceiling when a caller requests transient retries", async () => {
    const failures = Array.from({ length: 25 }, (_, index) => index + 1);
    const llm = flaky(failures, [reply("recovered after a prolonged outage")]);
    const engine = new AgentEngine({ llm: llm.client, tools: new ToolRegistry() });
    const events: EngineEvent[] = [];

    const result = await engine.run({ history: user("hi"), retryTransient: fast, onEvent: (event) => events.push(event) });

    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("recovered after a prolonged outage");
    expect(llm.calls()).toBe(26);
    expect(events.filter((event) => event.type === "model.retrying")).toHaveLength(25);
  });


  it("waits at least as long as a provider Retry-After hint", async () => {
    let calls = 0
    const client: EngineLLMClient = {
      model: "rate-limited",
      async complete() {
        calls += 1
        if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 35 })
        return reply("recovered") as never
      },
    }
    const events: EngineEvent[] = []
    const engine = new AgentEngine({ llm: client, tools: new ToolRegistry() })
    const result = await engine.run({
      history: user("hi"),
      retryTransient: { baseDelayMs: 1, maxDelayMs: 2, jitter: false },
      onEvent: (event) => events.push(event),
    })
    expect(result.status).toBe("completed")
    expect(events.find((event) => event.type === "model.retrying")).toMatchObject({ delayMs: 35 })
  })

  it("resumes after a tool call at the failed step without re-running the tool", async () => {
    let executed = 0;
    const registry = new ToolRegistry();
    const probe: EngineTool = {
      name: "probe",
      description: "probe",
      risk: "read",
      parameters: { type: "object", properties: {}, additionalProperties: true },
      execute: () => { executed += 1; return { ok: true }; },
    };
    registry.register(probe);
    // Call 1: asks for the tool. Calls 2 and 3: outage. Call 4: final answer.
    const llm = flaky([2, 3], [reply(null, [{ name: "probe", id: "c1" }]), reply("done after outage")]);
    const engine = new AgentEngine({ llm: llm.client, tools: registry });
    const result = await engine.run({ history: user("use the tool"), retryTransient: fast });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("done after outage");
    expect(executed).toBe(1);
  });

  it("uses three fixed initial retries, then continues at the configured interval until recovery", async () => {
    const llm = flaky([1, 2, 3, 4], [reply("back online")]);
    const engine = new AgentEngine({ llm: llm.client, tools: new ToolRegistry() });
    const events: EngineEvent[] = [];
    const result = await engine.run({
      history: user("hi"),
      retryTransient: { baseDelayMs: 5, maxDelayMs: 5, maxRetries: 3, continueRetryingEveryMs: 15 },
      onEvent: (event) => events.push(event),
    });
    expect(result.status).toBe("completed");
    expect(llm.calls()).toBe(5);
    expect(events.filter((event) => event.type === "model.retrying").map((event) => (event as { delayMs: number }).delayMs)).toEqual([5, 5, 5, 15]);
    expect(events.some((event) => event.type === "model.retry_exhausted")).toBe(false);
  });

  it("can still be cancelled after entering the continuing retry phase", async () => {
    const controller = new AbortController();
    let calls = 0;
    const client: EngineLLMClient = { model: "always-down", async complete() { calls += 1; throw unavailable(); } };
    const engine = new AgentEngine({ llm: client, tools: new ToolRegistry() });
    const result = await engine.run({
      history: user("hi"),
      retryTransient: { baseDelayMs: 1, maxDelayMs: 1, maxRetries: 1, continueRetryingEveryMs: 15 },
      signal: controller.signal,
      onEvent: (event) => { if (event.type === "model.retrying" && event.retry === 2) controller.abort(); },
    });
    expect(result.status).toBe("cancelled");
    expect(calls).toBe(2);
  });

  it("continues retrying beyond the historical default ceiling until the owner cancels", async () => {
    let calls = 0
    const controller = new AbortController()
    const failing: EngineLLMClient = {
      model: "always-down",
      async complete() { calls += 1; throw unavailable() },
    }
    const engine = new AgentEngine({ llm: failing, tools: new ToolRegistry() })
    const events: EngineEvent[] = []
    const result = await engine.run({
      history: user("hi"),
      retryTransient: { baseDelayMs: 1, maxDelayMs: 1 },
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event)
        if (event.type === "model.retrying" && event.retry === 8) controller.abort()
      },
    })
    expect(result.status).toBe("cancelled")
    expect(calls).toBe(8)
    expect(events).not.toContainEqual(expect.objectContaining({ type: "model.retry_exhausted" }))
  })

  it("does not retry a permanent failure such as an invalid API key", async () => {
    let calls = 0;
    const client: EngineLLMClient = {
      model: "m",
      async complete() { calls += 1; throw Object.assign(new Error("Invalid API key"), { status: 401 }); },
    };
    const engine = new AgentEngine({ llm: client, tools: new ToolRegistry() });
    const result = await engine.run({ history: user("hi"), retryTransient: fast });
    expect(result.status).toBe("failed");
    expect(calls).toBe(1);
  });

  it("does not retry an explicitly non-retryable entitlement error even when the provider returns 503", async () => {
    let calls = 0;
    const client: EngineLLMClient = {
      model: "billing-blocked",
      async complete() {
        calls += 1;
        throw Object.assign(
          new Error("Provider gemini requires an active payment method, credits, or subscription before completion."),
          { name: "LLMEntitlementError", retryable: false, status: 503 },
        );
      },
    };
    const engine = new AgentEngine({ llm: client, tools: new ToolRegistry() });
    const result = await engine.run({ history: user("hi"), retryTransient: fast });
    expect(result.status).toBe("failed");
    expect(calls).toBe(1);
  });

  it("fails over to a configured backup model on entitlement errors without retrying the blocked route", async () => {
    let primaryCalls = 0;
    let backupCalls = 0;
    const primary: EngineLLMClient = {
      model: "billing-blocked",
      async complete() {
        primaryCalls += 1;
        throw Object.assign(
          new Error("Provider requires an active payment method or credits before completion."),
          { name: "LLMEntitlementError", retryable: false, status: 403 },
        );
      },
    };
    const backup: EngineLLMClient = {
      model: "backup-model",
      async complete() {
        backupCalls += 1;
        return reply("completed using configured backup model");
      },
    };
    const events: EngineEvent[] = [];
    const engine = new AgentEngine({
      llm: (model) => model === "backup-model" ? backup : primary,
      fallbackModels: ["backup-model"],
      tools: new ToolRegistry(),
    });

    const result = await engine.run({ history: user("download wallpapers"), retryTransient: fast, onEvent: (event) => events.push(event) });

    expect(result.status).toBe("completed");
    expect(result.model).toBe("backup-model");
    expect(result.finalText).toBe("completed using configured backup model");
    expect(primaryCalls).toBe(1);
    expect(backupCalls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "model.fallback", from: "billing-blocked", to: "backup-model" }));
    expect(events.some((event) => event.type === "model.retrying")).toBe(false);
  });

  it("uses a configured model fallback after an unrecoverable primary API-key failure", async () => {
    let primaryCalls = 0;
    let backupCalls = 0;
    const primary: EngineLLMClient = {
      model: "primary-model",
      async complete() {
        primaryCalls += 1;
        throw Object.assign(new Error("The API key was rejected."), { status: 401, name: "LLMMissingCredentialError", retryable: false });
      },
    };
    const backup: EngineLLMClient = {
      model: "backup-model",
      async complete() {
        backupCalls += 1;
        return reply("completed on configured backup");
      },
    };
    const events: EngineEvent[] = [];
    const engine = new AgentEngine({
      llm: (model) => model === "backup-model" ? backup : primary,
      fallbackModels: ["backup-model"],
      tools: new ToolRegistry(),
    });
    const result = await engine.run({ history: user("complete this task"), retryTransient: fast, onEvent: (event) => events.push(event) });
    expect(result.status).toBe("completed");
    expect(result.model).toBe("backup-model");
    expect(primaryCalls).toBe(1);
    expect(backupCalls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "model.fallback", from: "primary-model", to: "backup-model" }));
  });


  it("uses a different configured route after an HTTP 400 request-shape failure", async () => {
    let primaryCalls = 0
    let backupCalls = 0
    const primary: EngineLLMClient = {
      model: "bad-request-model",
      async complete() {
        primaryCalls += 1
        throw Object.assign(new Error("Provider rejected the request payload."), { status: 400 })
      },
    }
    const backup: EngineLLMClient = {
      model: "backup-model",
      async complete() {
        backupCalls += 1
        return reply("completed using a compatible fallback")
      },
    }
    const events: EngineEvent[] = []
    const engine = new AgentEngine({
      llm: (model) => model === "backup-model" ? backup : primary,
      fallbackModels: ["backup-model"],
      tools: new ToolRegistry(),
    })
    const result = await engine.run({ history: user("complete this task"), retryTransient: fast, onEvent: (event) => events.push(event) })
    expect(result.status).toBe("completed")
    expect(result.model).toBe("backup-model")
    expect(primaryCalls).toBe(1)
    expect(backupCalls).toBe(1)
    expect(events).toContainEqual(expect.objectContaining({ type: "model.fallback", from: "bad-request-model", to: "backup-model" }))
  })

  it("does not impose a per-request timeout and retries only after the provider call fails", async () => {
    const observedTimeouts: Array<number | undefined> = []
    const client: EngineLLMClient = {
      model: "slow-model",
      async complete(_messages, options) {
        observedTimeouts.push(options?.timeoutMs)
        if (observedTimeouts.length === 1) throw Object.assign(new Error("request timed out"), { name: "LLMTimeoutError", status: 408 })
        return reply("finished after the provider recovered") as never
      },
    }
    const result = await new AgentEngine({ llm: client, tools: new ToolRegistry() })
      .run({ history: user("finish the task"), retryTransient: fast })
    expect(result.status).toBe("completed")
    expect(observedTimeouts).toEqual([undefined, undefined])
  })

  it("uses a configured model fallback when the primary model is explicitly unavailable", async () => {
    let primaryCalls = 0
    let backupCalls = 0
    const primary: EngineLLMClient = {
      model: "unsupported-model",
      async complete() {
        primaryCalls += 1
        throw Object.assign(new Error("The selected model was not found."), { status: 404 })
      },
    }
    const backup: EngineLLMClient = {
      model: "backup-model",
      async complete() {
        backupCalls += 1
        return reply("completed using the supported fallback")
      },
    }
    const events: EngineEvent[] = []
    const engine = new AgentEngine({
      llm: (model) => model === "backup-model" ? backup : primary,
      fallbackModels: ["backup-model"],
      tools: new ToolRegistry(),
    })
    const result = await engine.run({ history: user("complete this task"), retryTransient: fast, onEvent: (event) => events.push(event) })
    expect(result.status).toBe("completed")
    expect(result.model).toBe("backup-model")
    expect(primaryCalls).toBe(1)
    expect(backupCalls).toBe(1)
    expect(events).toContainEqual(expect.objectContaining({ type: "model.fallback", from: "unsupported-model", to: "backup-model" }))
  })

  it("rotates an explicitly configured alternate credential after an entitlement block", async () => {
    let primaryCalls = 0;
    let alternateCalls = 0;
    const primary: EngineLLMClient = {
      model: "shared-model",
      routeKey: "shared-model::credential:default",
      async complete() {
        primaryCalls += 1;
        throw Object.assign(new Error("Insufficient credits for this key."), { name: "LLMEntitlementError", retryable: false, status: 403 });
      },
    };
    const alternate: EngineLLMClient = {
      model: "shared-model",
      routeKey: "shared-model::credential:ALT_PROVIDER_KEY",
      credentialProfile: "ALT_PROVIDER_KEY",
      async complete() {
        alternateCalls += 1;
        return reply("completed using alternate provider credentials");
      },
    };
    const events: EngineEvent[] = [];
    const engine = new AgentEngine({
      llm: (_model, _index, credentialProfile) => credentialProfile ? alternate : primary,
      fallbackRoutes: () => [{ model: "shared-model", credentialProfile: "ALT_PROVIDER_KEY" }],
      tools: new ToolRegistry(),
    });

    const result = await engine.run({ history: user("download wallpapers"), retryTransient: fast, onEvent: (event) => events.push(event) });

    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("completed using alternate provider credentials");
    expect(primaryCalls).toBe(1);
    expect(alternateCalls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "model.fallback", from: "shared-model", to: "shared-model" }));
  });

  it("does not keep retrying the same route when all configured fallback models are entitlement-blocked", async () => {
    let primaryCalls = 0;
    let backupCalls = 0;
    const blocked = (model: string, increment: () => void): EngineLLMClient => ({
      model,
      async complete() {
        increment();
        throw Object.assign(new Error("Insufficient credits for this provider."), { name: "LLMEntitlementError", retryable: false, status: 503 });
      },
    });
    const primary = blocked("primary", () => { primaryCalls += 1; });
    const backup = blocked("backup", () => { backupCalls += 1; });
    const engine = new AgentEngine({
      llm: (model) => model === "backup" ? backup : primary,
      fallbackModels: ["backup"],
      tools: new ToolRegistry(),
    });

    const result = await engine.run({ history: user("download wallpapers"), retryTransient: fast });

    expect(result.status).toBe("failed");
    expect(primaryCalls).toBe(1);
    expect(backupCalls).toBe(1);
  });

  it("stops waiting as soon as the run is cancelled", async () => {
    const client: EngineLLMClient = { model: "m", async complete() { throw unavailable(); } };
    const engine = new AgentEngine({ llm: client, tools: new ToolRegistry() });
    const controller = new AbortController();
    const started = Date.now();
    const run = engine.run({
      history: user("hi"),
      retryTransient: { baseDelayMs: 60_000, maxDelayMs: 60_000 },
      signal: controller.signal,
      onEvent: (event) => { if (event.type === "model.retrying") setTimeout(() => controller.abort(), 20); },
    });
    const result = await run;
    expect(result.status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("model failover versus waiting for the primary model", () => {
  const probeTool = (onRun: () => void): EngineTool => ({
    name: "probe",
    description: "probe",
    risk: "read",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: () => { onRun(); return { ok: true }; },
  });

  it("a run with disableModelFallback waits for its own model and never uses the fallback", async () => {
    const primary = flaky([1, 2], [reply("answered by the primary")]);
    const backup = scriptedLLM([{ text: "answered by the weak fallback" }], "backup-model");
    const engine = new AgentEngine({
      llm: (model?: string) => (model === "backup" ? backup.client : primary.client),
      tools: new ToolRegistry(),
      fallbackModels: ["backup"],
    });
    const events: EngineEvent[] = [];
    const result = await engine.run({ history: user("hi"), retryTransient: fast, disableModelFallback: true, onEvent: (event) => events.push(event) });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("answered by the primary");
    expect(result.model).toBe("flaky-model");
    expect(backup.requests).toHaveLength(0);
    expect(events.some((event) => event.type === "model.fallback")).toBe(false);
    expect(events.filter((event) => event.type === "model.retrying")).toHaveLength(2);
    expect(events.filter((event) => event.type === "model.resumed")).toHaveLength(1);
  });

  it("pins fallback clients at run start when model configuration changes mid-run", async () => {
    const firstFallback = scriptedLLM([{ text: "snapshot fallback" }], "backup-one")
    const nextFallback = scriptedLLM([{ text: "new config fallback" }], "backup-two")
    let currentFallback = firstFallback.client
    const primary: EngineLLMClient = {
      model: "primary",
      async complete() {
        currentFallback = nextFallback.client
        throw unavailable()
      },
    }
    const engine = new AgentEngine({
      llm: (model?: string) => model === "backup" ? currentFallback : primary,
      tools: new ToolRegistry(),
      fallbackModels: ["backup"],
    })
    const result = await engine.run({ history: user("hi") })
    expect(result.status).toBe("completed")
    expect(result.finalText).toBe("snapshot fallback")
    expect(firstFallback.requests).toHaveLength(1)
    expect(nextFallback.requests).toHaveLength(0)
  })

  it("still fails over for an ordinary run (interactive behaviour is unchanged)", async () => {
    const primary = flaky([1], [reply("answered by the primary")]);
    const backup = scriptedLLM([{ text: "answered by backup" }], "backup-model");
    const engine = new AgentEngine({
      llm: (model?: string) => (model === "backup" ? backup.client : primary.client),
      tools: new ToolRegistry(),
      fallbackModels: ["backup"],
    });
    const result = await engine.run({ history: user("hi"), retryTransient: fast });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("answered by backup");
  });

  it("disableModelFallback without retryTransient fails the run instead of switching models", async () => {
    const primary = flaky([1], [reply("never reached")]);
    const backup = scriptedLLM([{ text: "must not run" }], "backup-model");
    const engine = new AgentEngine({
      llm: (model?: string) => (model === "backup" ? backup.client : primary.client),
      tools: new ToolRegistry(),
      fallbackModels: ["backup"],
    });
    const result = await engine.run({ history: user("hi"), disableModelFallback: true });
    expect(result.status).toBe("failed");
    expect(backup.requests).toHaveLength(0);
  });

  it("a failover lasts one turn: the next turn is answered by the primary model again", async () => {
    let executed = 0;
    const registry = new ToolRegistry();
    registry.register(probeTool(() => { executed += 1; }));
    // Primary fails on its first call only; after that it is healthy again.
    const primary = flaky([1], [reply("answered by the primary again")]);
    const backup = scriptedLLM([{ calls: [{ name: "probe", id: "c1" }] }], "backup-model");
    const engine = new AgentEngine({
      llm: (model?: string) => (model === "backup" ? backup.client : primary.client),
      tools: registry,
      fallbackModels: ["backup"],
    });
    const events: EngineEvent[] = [];
    const result = await engine.run({ history: user("use the tool"), onEvent: (event) => events.push(event) });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("answered by the primary again");
    expect(result.model).toBe("flaky-model");
    expect(executed).toBe(1);
    // The backup selected the tool once; the next agent turn resumes on the primary model.
    expect(backup.requests).toHaveLength(1);
    expect(primary.calls()).toBeGreaterThanOrEqual(2);
    expect(events.filter((event) => event.type === "model.fallback")).toHaveLength(1);
  });

  it("tries the primary first on every turn, even while it is still down", async () => {
    const registry = new ToolRegistry();
    registry.register(probeTool(() => undefined));
    const primary = flaky([1, 2], [reply("unused")]);
    const backup = scriptedLLM([{ calls: [{ name: "probe", id: "c1" }] }, { text: "backup finished" }], "backup-model");
    const engine = new AgentEngine({
      llm: (model?: string) => (model === "backup" ? backup.client : primary.client),
      tools: registry,
      fallbackModels: ["backup"],
    });
    const events: EngineEvent[] = [];
    const result = await engine.run({ history: user("use the tool"), onEvent: (event) => events.push(event) });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("backup finished");
    // Turn 1 and turn 2 each started on the primary model and each failed over once.
    expect(primary.calls()).toBe(2);
    expect(events.filter((event) => event.type === "model.fallback")).toHaveLength(2);
  });
});
