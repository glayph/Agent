import { jest } from "@jest/globals";
import type { LLMResponse } from "@miki/config";
import {
  LLMAPIError,
  LLMMissingCredentialError,
  LLMRateLimitError,
  LLMTimeoutError,
} from "../provider/errors.js";
import { resolveModelRouterConfig } from "./config.js";
import {
  AllModelsFailedError,
  ExplicitModelUnavailableError,
  unwrapRouterError,
} from "./errors.js";
import { ModelRouter } from "./router.js";
import type { ModelRouterProviders } from "./types.js";

type CompleteOpts = {
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
  credentialProfile?: string;
};

function reply(model: string): LLMResponse {
  return {
    choices: [{ message: { role: "assistant", content: `from ${model}` } }],
  } as unknown as LLMResponse;
}

class FakeProviders implements ModelRouterProviders {
  calls: Array<{ model: string; credential?: string }> = [];
  down = new Map<string, unknown>(); // model → error to throw
  notReady = new Map<string, string>(); // model → reason
  credentialsByProvider: Record<string, string[]> = {};
  failCredential = new Map<string, unknown>(); // `${model}|${credential}` → error

  async isModelReady(model: string) {
    const reason = this.notReady.get(model);
    return reason ? { available: false, reason } : { available: true };
  }

  async complete(
    model: string,
    _messages: unknown[],
    options: CompleteOpts = {},
  ): Promise<LLMResponse> {
    this.calls.push({ model, credential: options.credentialProfile });
    const perCred = this.failCredential.get(`${model}|${options.credentialProfile}`);
    if (perCred) throw perCred;
    const error = this.down.get(model);
    if (error) throw error;
    return reply(model);
  }

  providerIdFor(model: string) {
    return model.split("/")[0];
  }

  credentialProfiles(model: string, configured: string[] = []) {
    const provider = this.providerIdFor(model)!;
    return this.credentialsByProvider[provider] ?? configured;
  }
}

function makeRouter(
  providers: FakeProviders,
  block: unknown = {
    lanes: {
      default: { primary: "a/model-a", fallbacks: ["b/model-b", "c/model-c"] },
      heartbeat: { primary: "cheap/tiny" },
      subagent: { primary: "a/model-a", fallbacks: ["c/model-c"] },
    },
    roles: { forge: "subagent", scout: { primary: "s/scout", fallbacks: ["a/model-a"] } },
  },
  extra: Partial<ConstructorParameters<typeof ModelRouter>[0]> = {},
) {
  const logger = jest.fn();
  const router = new ModelRouter({
    providers,
    config: resolveModelRouterConfig({ modelRouter: block, defaultModel: "a/model-a" }),
    logger,
    ...extra,
  });
  return { router, logger };
}

const messages = [{ role: "user" as const, content: "hi" }];
const rateLimit = (p = "a") => new LLMRateLimitError("busy", { providerId: p, status: 429 });
const outage = (p = "a") =>
  new LLMAPIError("Provider down", { providerId: p, status: 503 });

describe("ModelRouter — lanes and selection", () => {
  it("uses the lane's primary and marks it configured_default", () => {
    const { router } = makeRouter(new FakeProviders());
    const sel = router.select({ lane: "default" });
    expect(sel.source).toBe("configured_default");
    expect(sel.chain).toEqual(["a/model-a", "b/model-b", "c/model-c"]);
  });

  it("gives the heartbeat lane its own (cheap) model", () => {
    const { router } = makeRouter(new FakeProviders());
    expect(router.select({ lane: "heartbeat" }).model).toBe("cheap/tiny");
  });

  it("falls back to the default lane for an unknown lane", () => {
    const { router } = makeRouter(new FakeProviders());
    const sel = router.select({ lane: "nonexistent" });
    expect(sel.chain[0]).toBe("a/model-a");
    expect(sel.profileOrigin).toBe("default_lane");
  });

  it("lets a role bind to a lane or carry its own profile", () => {
    const { router } = makeRouter(new FakeProviders());
    expect(router.select({ role: "forge" }).chain).toEqual(["a/model-a", "c/model-c"]);
    expect(router.select({ role: "scout" }).chain).toEqual(["s/scout", "a/model-a"]);
    expect(router.select({ role: "SCOUT" }).profileOrigin).toBe("role");
  });

  it("an explicit model is a single-entry strict chain", () => {
    const { router } = makeRouter(new FakeProviders());
    const sel = router.select({ lane: "default", explicitModel: "z/pick" });
    expect(sel).toMatchObject({ source: "explicit_override", chain: ["z/pick"], model: "z/pick" });
  });

  it("preferModel reorders a configured chain but never an explicit one", () => {
    const { router } = makeRouter(new FakeProviders());
    expect(router.select({ preferModel: "c/model-c" }).chain[0]).toBe("c/model-c");
    expect(router.select({ preferModel: "not/inchain" }).chain[0]).toBe("a/model-a");
    expect(
      router.select({ explicitModel: "z/pick", preferModel: "c/model-c" }).chain,
    ).toEqual(["z/pick"]);
  });

  it("failover disabled → single-model chain", () => {
    const { router } = makeRouter(new FakeProviders(), {
      enabled: false,
      lanes: { default: { primary: "a/model-a", fallbacks: ["b/model-b"] } },
    });
    expect(router.select().chain).toEqual(["a/model-a"]);
  });
});

describe("ModelRouter — failover on configured defaults", () => {
  it("serves from primary when healthy, with no hops", async () => {
    const providers = new FakeProviders();
    const { router } = makeRouter(providers);
    const result = await router.complete({ messages });
    expect(result.model).toBe("a/model-a");
    expect(result.failedOver).toBe(false);
    expect(result.hops).toEqual([]);
  });

  it("simulated provider outage → falls back and logs the hop", async () => {
    const providers = new FakeProviders();
    providers.down.set("a/model-a", outage("a"));
    const { router, logger } = makeRouter(providers);
    const seen: string[] = [];
    router.onHop((hop) => seen.push(`${hop.action}:${hop.from}->${hop.to}`));

    const result = await router.complete({ messages });

    expect(result.model).toBe("b/model-b");
    expect(result.failedOver).toBe(true);
    expect(result.hops).toHaveLength(1);
    expect(result.hops[0]).toMatchObject({
      action: "fallback",
      kind: "server_error",
      from: "a/model-a",
      to: "b/model-b",
      source: "configured_default",
    });
    expect(seen).toEqual(["fallback:a/model-a->b/model-b"]);
    expect(logger).toHaveBeenCalledWith("warn", "hop.fallback", expect.any(Object));
    expect(router.recentHops()).toHaveLength(1);
    expect(router.stats()).toMatchObject({ calls: 1, succeeded: 1, failovers: 1 });
  });

  it("walks the whole chain and reports AllModelsFailedError when every hop fails", async () => {
    const providers = new FakeProviders();
    for (const m of ["a/model-a", "b/model-b", "c/model-c"]) providers.down.set(m, outage(m[0]));
    const { router } = makeRouter(providers);
    const error = await router.complete({ messages }).catch((e) => e);
    expect(error).toBeInstanceOf(AllModelsFailedError);
    expect(error.attemptedModels).toEqual(["a/model-a", "b/model-b", "c/model-c"]);
    expect(error.hops.map((h: { action: string }) => h.action)).toEqual([
      "fallback",
      "fallback",
      "exhausted",
    ]);
    // Root cause stays reachable for user-facing error mapping.
    expect(unwrapRouterError(error)).toBeInstanceOf(LLMAPIError);
    expect(router.stats().failed).toBe(1);
  });

  it("skips a fallback that is not ready instead of calling it", async () => {
    const providers = new FakeProviders();
    providers.down.set("a/model-a", rateLimit());
    providers.notReady.set("b/model-b", "runtime down");
    const { router } = makeRouter(providers);
    const result = await router.complete({ messages });
    expect(result.model).toBe("c/model-c");
    expect(providers.calls.map((c) => c.model)).toEqual(["a/model-a", "c/model-c"]);
    expect(result.hops.map((h) => h.action)).toEqual(["fallback", "preflight_skip"]);
  });

  it("missing credentials on the primary fails over (replaces the old BUG-04 retry)", async () => {
    const providers = new FakeProviders();
    providers.down.set("a/model-a", new LLMMissingCredentialError("no key", { providerId: "a" }));
    const { router } = makeRouter(providers);
    const result = await router.complete({ messages });
    expect(result.model).toBe("b/model-b");
    expect(result.hops[0]!.kind).toBe("auth");
  });

  it("does NOT fail over for aborts, bad requests or unknown errors", async () => {
    const providers = new FakeProviders();
    const { router } = makeRouter(providers);

    providers.down.set("a/model-a", new LLMAPIError("bad tools schema", { providerId: "a", status: 400 }));
    await expect(router.complete({ messages })).rejects.toThrow("bad tools schema");

    providers.down.set("a/model-a", new TypeError("programmer bug"));
    await expect(router.complete({ messages })).rejects.toThrow("programmer bug");
    expect(providers.calls.every((c) => c.model === "a/model-a")).toBe(true);

    const controller = new AbortController();
    providers.down.set("a/model-a", timeoutErr());
    controller.abort();
    await expect(router.complete({ messages, signal: controller.signal })).rejects.toThrow();
    expect(providers.calls.every((c) => c.model === "a/model-a")).toBe(true);
  });

  it("honours a preflighted selection and continues after the start index", async () => {
    const providers = new FakeProviders();
    providers.notReady.set("a/model-a", "no key");
    const { router } = makeRouter(providers);
    const selection = await router.selectReady({});
    expect(selection).toMatchObject({ model: "b/model-b", index: 1, preflighted: true });
    providers.down.set("b/model-b", outage("b"));
    const result = await router.complete({ messages, selection });
    expect(result.model).toBe("c/model-c");
    expect(providers.calls.map((c) => c.model)).toEqual(["b/model-b", "c/model-c"]);
  });

  it("selectReady throws when nothing in the chain is ready", async () => {
    const providers = new FakeProviders();
    for (const m of ["a/model-a", "b/model-b", "c/model-c"]) providers.notReady.set(m, "off");
    const { router } = makeRouter(providers);
    await expect(router.selectReady({})).rejects.toBeInstanceOf(AllModelsFailedError);
  });

  it("caps total attempts", async () => {
    const providers = new FakeProviders();
    for (const m of ["a/model-a", "b/model-b", "c/model-c"]) providers.down.set(m, outage(m[0]));
    const { router } = makeRouter(providers, {
      max_attempts: 2,
      lanes: { default: { primary: "a/model-a", fallbacks: ["b/model-b", "c/model-c"] } },
    });
    await expect(router.complete({ messages })).rejects.toBeInstanceOf(AllModelsFailedError);
    expect(providers.calls).toHaveLength(2);
  });

  it("a throwing hop listener never breaks routing", async () => {
    const providers = new FakeProviders();
    providers.down.set("a/model-a", outage());
    const { router } = makeRouter(providers);
    router.onHop(() => {
      throw new Error("listener bug");
    });
    await expect(router.complete({ messages })).resolves.toMatchObject({ model: "b/model-b" });
  });
});

function timeoutErr() {
  return new LLMTimeoutError("timed out", { providerId: "a" });
}

describe("ModelRouter — explicit override is strict", () => {
  it("simulated outage on an explicit model raises a visible error, never a silent fallback", async () => {
    const providers = new FakeProviders();
    providers.down.set("z/pick", outage("z"));
    const { router } = makeRouter(providers);

    const error = await router
      .complete({ explicitModel: "z/pick", messages })
      .catch((e) => e);

    expect(error).toBeInstanceOf(ExplicitModelUnavailableError);
    expect(error.requestedModel).toBe("z/pick");
    expect(error.message).toMatch(/no other model was substituted/);
    expect(error.hops[0]).toMatchObject({ action: "explicit_blocked", source: "explicit_override" });
    expect(providers.calls.map((c) => c.model)).toEqual(["z/pick"]); // nothing else was tried
    expect(unwrapRouterError(error)).toBeInstanceOf(LLMAPIError);
    expect(router.stats().explicitBlocked).toBe(1);
  });

  it("an explicit model that is not ready raises at selection time", async () => {
    const providers = new FakeProviders();
    providers.notReady.set("z/pick", "llama.cpp runtime is not ready.");
    const { router } = makeRouter(providers);
    const error = await router.selectReady({ explicitModel: "z/pick" }).catch((e) => e);
    expect(error).toBeInstanceOf(ExplicitModelUnavailableError);
    expect(error.message).toContain("llama.cpp runtime is not ready.");
    expect(providers.calls).toEqual([]);
  });

  it("a healthy explicit model just works and reports its source", async () => {
    const { router } = makeRouter(new FakeProviders());
    const result = await router.complete({ explicitModel: "z/pick", messages });
    expect(result.model).toBe("z/pick");
    expect(result.selection.source).toBe("explicit_override");
  });
});

describe("ModelRouter — credential rotation", () => {
  it("tries the provider's next credential before hopping to another model", async () => {
    const providers = new FakeProviders();
    providers.credentialsByProvider.a = ["A_KEY", "A_KEY_2"];
    providers.failCredential.set("a/model-a|A_KEY", rateLimit("a"));
    const { router } = makeRouter(providers);

    const result = await router.complete({ messages });

    expect(result.model).toBe("a/model-a");
    expect(providers.calls).toEqual([
      { model: "a/model-a", credential: "A_KEY" },
      { model: "a/model-a", credential: "A_KEY_2" },
    ]);
    expect(result.hops).toHaveLength(1);
    expect(result.hops[0]).toMatchObject({
      action: "rotate_credential",
      credential: "A_KEY",
      nextCredential: "A_KEY_2",
      kind: "rate_limit",
    });
    expect(router.stats().credentialRotations).toBe(1);
  });

  it("all credentials rejected → then hops to the next model", async () => {
    const providers = new FakeProviders();
    providers.credentialsByProvider.a = ["A_KEY", "A_KEY_2"];
    providers.failCredential.set("a/model-a|A_KEY", rateLimit("a"));
    providers.failCredential.set("a/model-a|A_KEY_2", rateLimit("a"));
    const { router } = makeRouter(providers);
    const result = await router.complete({ messages });
    expect(result.model).toBe("b/model-b");
    expect(result.hops.map((h) => h.action)).toEqual(["rotate_credential", "fallback"]);
  });

  it("does not rotate credentials for an outage (a different key can't help)", async () => {
    const providers = new FakeProviders();
    providers.credentialsByProvider.a = ["A_KEY", "A_KEY_2"];
    providers.down.set("a/model-a", outage("a"));
    const { router } = makeRouter(providers);
    await router.complete({ messages });
    expect(providers.calls.filter((c) => c.model === "a/model-a")).toHaveLength(1);
  });

  it("explicit override may rotate credentials (same model) but still never hops", async () => {
    const providers = new FakeProviders();
    providers.credentialsByProvider.z = ["Z_KEY", "Z_KEY_2"];
    providers.failCredential.set("z/pick|Z_KEY", rateLimit("z"));
    const { router } = makeRouter(providers);
    const ok = await router.complete({ explicitModel: "z/pick", messages });
    expect(ok.model).toBe("z/pick");

    providers.failCredential.set("z/pick|Z_KEY_2", rateLimit("z"));
    const error = await router.complete({ explicitModel: "z/pick", messages }).catch((e) => e);
    expect(error).toBeInstanceOf(ExplicitModelUnavailableError);
    expect(providers.calls.every((c) => c.model === "z/pick")).toBe(true);
  });

  it("never logs secret values", async () => {
    const providers = new FakeProviders();
    providers.down.set(
      "a/model-a",
      new LLMAPIError("upstream said api_key=sk-SECRET123 Bearer abc.def", { providerId: "a", status: 502 }),
    );
    const { router, logger } = makeRouter(providers);
    await router.complete({ messages });
    const logged = JSON.stringify(logger.mock.calls);
    expect(logged).not.toContain("sk-SECRET123");
    expect(logged).not.toContain("abc.def");
  });
});

describe("ModelRouter — prepare hook", () => {
  it("prepares failover targets and treats a throwing prepare as unavailable", async () => {
    const providers = new FakeProviders();
    providers.down.set("a/model-a", outage());
    const prepare = jest.fn(async (model: string) => {
      if (model === "b/model-b") throw new Error("cannot start runtime");
    });
    const { router } = makeRouter(providers, undefined, { prepare });
    const result = await router.complete({ messages });
    expect(prepare).toHaveBeenCalledWith("b/model-b");
    expect(result.model).toBe("c/model-c");
  });
});

describe("ModelRouter — per-attempt timeout", () => {
  it("aborts a hung provider at the deadline and fails over to the next model", async () => {
    const providers = new FakeProviders();
    const original = providers.complete.bind(providers);
    providers.complete = async (model, msgs, options = {}) => {
      if (model === "a/model-a") {
        providers.calls.push({ model, credential: options.credentialProfile });
        await new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")));
        });
      }
      return original(model, msgs, options);
    };
    const { router } = makeRouter(providers);
    const result = await router.complete({ messages, attemptTimeoutMs: 30 });
    expect(result.model).toBe("b/model-b");
    expect(result.hops[0]).toMatchObject({ action: "fallback", kind: "timeout", from: "a/model-a" });
  });

  it("a caller abort is not treated as a timeout and never fails over", async () => {
    const providers = new FakeProviders();
    providers.complete = async (_model, _msgs, options = {}) =>
      new Promise((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")));
      });
    const { router } = makeRouter(providers);
    const controller = new AbortController();
    const pending = router.complete({ messages, attemptTimeoutMs: 5_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow("aborted");
  });

  it("explicit override that hangs raises the explicit error (timeout kind)", async () => {
    const providers = new FakeProviders();
    providers.complete = async (_model, _msgs, options = {}) =>
      new Promise((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")));
      });
    const { router } = makeRouter(providers);
    const error = await router
      .complete({ explicitModel: "z/pick", messages, attemptTimeoutMs: 20 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ExplicitModelUnavailableError);
    expect(error.failureKind).toBe("timeout");
  });

  it("per-model deadline function and extra function receive the model being tried", async () => {
    const providers = new FakeProviders();
    providers.down.set("a/model-a", outage());
    const seenExtra: string[] = [];
    const { router } = makeRouter(providers);
    await router.complete({
      messages,
      attemptTimeoutMs: (m) => (m.startsWith("a/") ? 1_000 : 2_000),
      extra: (m) => {
        seenExtra.push(m);
        return { tag: m };
      },
    });
    expect(seenExtra).toEqual(["a/model-a", "b/model-b"]);
  });
});
