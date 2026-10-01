import { jest } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgentOrchestrator } from "./agent.js";
import { providerRegistry } from "./llm/provider/registry.js";
import { LLMAPIError } from "./llm/provider/errors.js";
import { ExplicitModelUnavailableError } from "./llm/model-router/index.js";
import type { RuntimePaths } from "./paths.js";

function makeRuntimePaths(workspaceDir: string): RuntimePaths {
  return {
    configDir: path.join(workspaceDir, "config"),
    dataDir: path.join(workspaceDir, "data"),
    skillsDir: path.join(workspaceDir, "src", "skills"),
    cacheDir: path.join(workspaceDir, "data", "cache"),
    binDir: path.join(workspaceDir, "bin"),
    docsDir: path.join(workspaceDir, "docs"),
    outputDir: path.join(workspaceDir, "output"),
    sourceDir: workspaceDir,
  };
}

const ROUTER_YAML = [
  "agent:",
  "  memory:",
  "    long_term_enabled: false",
  "  model_router:",
  "    lanes:",
  "      default:",
  "        primary: a/simple",
  "        fallbacks: [b/backup]",
  "      complex:",
  "        primary: a/complex",
  "        fallbacks: [b/backup]",
  "      heartbeat:",
  "        primary: cheap/tiny",
  "      subagent:",
  "        primary: a/simple",
  "        fallbacks: [b/backup]",
  "    roles:",
  "      scout: { primary: s/scout, fallbacks: [b/backup] }",
  "",
].join("\n");

function answer(text: string) {
  return {
    id: "r1",
    choices: [
      { index: 0, finish_reason: "stop", message: { role: "assistant", content: text } },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

describe("AgentOrchestrator → ModelRouter integration", () => {
  let workspaceDir: string;
  let orchestrator: AgentOrchestrator;
  let readySpy: jest.SpiedFunction<typeof providerRegistry.isModelReady>;
  let completeSpy: jest.SpiedFunction<typeof providerRegistry.complete>;
  const notReady = new Set<string>();
  const failing = new Map<string, unknown>();
  const called: string[] = [];

  beforeEach(() => {
    notReady.clear();
    failing.clear();
    called.length = 0;
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "Miki-router-"));
    fs.mkdirSync(path.join(workspaceDir, "config"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "config", "agent.yaml"), ROUTER_YAML, "utf8");
    readySpy = jest
      .spyOn(providerRegistry, "isModelReady")
      .mockImplementation(async (model: string) =>
        notReady.has(model)
          ? { available: false, reason: `${model} runtime is not ready.` }
          : { available: true },
      );
    completeSpy = jest
      .spyOn(providerRegistry, "complete")
      .mockImplementation((async (model: string) => {
        called.push(model);
        const error = failing.get(model);
        if (error) throw error;
        return answer(`Hello from ${model}, how can I help you today?`);
      }) as never);
    orchestrator = new AgentOrchestrator(makeRuntimePaths(workspaceDir));
  });

  afterEach(async () => {
    readySpy.mockRestore();
    completeSpy.mockRestore();
    await orchestrator.stopBackgroundTasks();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  async function collect(
    message: string,
    options: Parameters<AgentOrchestrator["runAgentLoop"]>[3] = {},
  ) {
    const events: Array<Record<string, unknown>> = [];
    for await (const raw of orchestrator.runAgentLoop(
      `s-${Math.random().toString(36).slice(2)}`,
      message,
      undefined,
      options,
    )) {
      try {
        events.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // non-JSON chunk
      }
    }
    return events;
  }

  const internals = () =>
    orchestrator as unknown as {
      _resolveTurnModel: (
        complexity: string,
        requested?: string,
        route?: { lane?: string; role?: string; autonomous?: boolean },
      ) => Promise<{ model: string; chain: string[]; lane: string; source: string }>;
    };

  it("routes by lane: simple → default, complex → complex, autonomous → heartbeat, role → its own profile", async () => {
    const r = internals();
    expect((await r._resolveTurnModel("simple")).model).toBe("a/simple");
    expect((await r._resolveTurnModel("complex")).model).toBe("a/complex");
    const hb = await r._resolveTurnModel("complex", undefined, { autonomous: true });
    expect(hb).toMatchObject({ model: "cheap/tiny", lane: "heartbeat" });
    expect((await r._resolveTurnModel("simple", undefined, { role: "scout", lane: "subagent" })).model).toBe(
      "s/scout",
    );
    expect((await r._resolveTurnModel("simple", undefined, { lane: "subagent" })).lane).toBe("subagent");
  });

  it("skips an unready primary at selection time and starts on the next candidate", async () => {
    notReady.add("a/simple");
    const selection = await internals()._resolveTurnModel("simple");
    expect(selection.model).toBe("b/backup");
    expect(orchestrator.modelRouter.recentHops()[0]).toMatchObject({ action: "preflight_skip", from: "a/simple" });
  });

  it("explicit requestedModel is strict: unavailable → visible error, no other model used", async () => {
    notReady.add("z/pick");
    await expect(collect("hello", { requestedModel: "z/pick" })).rejects.toBeInstanceOf(
      ExplicitModelUnavailableError,
    );
    expect(called).toEqual([]);
  });

  it("explicit requestedModel failing at call time surfaces the error and never substitutes", async () => {
    failing.set("z/pick", new LLMAPIError("upstream down", { providerId: "z", status: 503 }));
    const events = await collect("hello", { requestedModel: "z/pick" });
    expect(called.every((m) => m === "z/pick")).toBe(true);
    const text = events.map((e) => String(e.content ?? "")).join("\n");
    expect(text).toMatch(/selected explicitly, so no other model was substituted/);
  });

  it("simulated outage of the primary during a turn → answers from the fallback and logs the hop", async () => {
    failing.set("a/simple", new LLMAPIError("Provider a down", { providerId: "a", status: 503 }));
    const events = await collect("hello");
    expect(called.slice(0, 1)).toEqual(["a/simple"]);
    expect(called).toContain("b/backup");
    const text = events.map((e) => String(e.content ?? "")).join("\n");
    expect(text).toContain("Hello from b/backup");
    expect(orchestrator.modelRouter.recentHops().some((h) => h.action === "fallback" && h.to === "b/backup")).toBe(true);
    expect(orchestrator.modelRouter.stats().failovers).toBeGreaterThanOrEqual(1);
  });

  it("all candidates down → the user gets a clear message listing what was tried", async () => {
    failing.set("a/simple", new LLMAPIError("down", { providerId: "a", status: 503 }));
    failing.set("b/backup", new LLMAPIError("down", { providerId: "b", status: 503 }));
    const events = await collect("hello");
    const text = events.map((e) => String(e.content ?? "")).join("\n");
    expect(text).toMatch(/Models tried: a\/simple, b\/backup/);
  });

  it("reloadConfig re-reads lanes", async () => {
    fs.writeFileSync(
      path.join(workspaceDir, "config", "agent.yaml"),
      ROUTER_YAML.replace("primary: a/simple\n        fallbacks: [b/backup]\n      complex", "primary: c/changed\n      complex"),
      "utf8",
    );
    await orchestrator.reloadConfig();
    expect((await internals()._resolveTurnModel("simple")).model).toBe("c/changed");
  });
});
