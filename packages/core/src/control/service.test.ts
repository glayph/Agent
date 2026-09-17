import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgentControlService } from "./service.js";

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-control-"));
  let config: Record<string, unknown> = {
    agent: { name: "Miki", resource: { mode: "balanced" } },
    tools: { tool_state: { web_search: true } },
    models: [{ model_name: "opencode/mimo-v2.5-free", api_key: "secret" }],
  };
  const controller = {
    getConfig: () => structuredClone(config),
    validateConfig: () => ({ valid: true }),
    validatePatch: (patch: Record<string, unknown>) => ({
      valid: !("factory_reset" in patch),
    }),
    applyPatch: async (patch: Record<string, unknown>) => {
      config = { ...config, ...patch };
      return {
        runtime_apply_status: "applied",
        gateway_restart_required: false,
      };
    },
    setToolState: async (name: string, enabled: boolean) => {
      const tools = (config.tools || {}) as Record<string, unknown>;
      const toolState = (tools.tool_state || {}) as Record<string, unknown>;
      config = {
        ...config,
        tools: { ...tools, tool_state: { ...toolState, [name]: enabled } },
      };
      return {
        runtime_apply_status: "applied",
        gateway_restart_required: false,
      };
    },
  };
  const service = new AgentControlService({
    controller,
    runtimePaths: { dataDir: path.join(root, "data") } as never,
  });
  return { root, service, controller };
}

describe("AgentControlService", () => {
  it("lists only typed management capabilities", () => {
    const { service } = createHarness();
    const capabilities = service.listCapabilities();
    expect(capabilities.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "capabilities",
        "system_state",
        "models",
        "config",
        "tool_state",
        "runtime",
      ]),
    );
    expect(
      capabilities.some(
        (item) => item.id === "shell" || item.id === "factory_reset",
      ),
    ).toBe(false);
  });

  it("redacts secrets from state and plan input", async () => {
    const { service } = createHarness();
    const state = service.getState();
    expect(JSON.stringify(state)).not.toContain("secret");
    const plan = await service.plan({
      capability: "config",
      action: "preview",
      input: { patch: { api_key: "secret-value", agent: { name: "Miki 2" } } },
      context: { origin: "local" },
    });
    expect(JSON.stringify(plan)).not.toContain("secret-value");
  });

  it("rejects unsupported configuration paths before mutation", async () => {
    const { service, controller } = createHarness();
    const patch = await service.execute({
      capability: "config",
      action: "patch",
      input: { patch: { factory_reset: true } },
      context: { origin: "local" },
    });
    expect(patch.ok).toBe(false);
    expect(patch.status).toBe("failed");
    expect(
      (controller.getConfig() as Record<string, unknown>).factory_reset,
    ).toBeUndefined();
  });

  it("applies a safe tool-state change and reads back state", async () => {
    const { service } = createHarness();
    const outcome = await service.execute({
      capability: "tool_state",
      action: "set",
      input: { name: "web_search", enabled: false },
      context: { origin: "local" },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.changed).toBe(true);
    expect(JSON.stringify(outcome.state)).toContain("web_search");
  });

  it("rejects a plan whose input was changed after planning", async () => {
    const { service } = createHarness();
    const plan = await service.plan({
      capability: "tool_state",
      action: "set",
      input: { name: "web_search", enabled: false },
      context: { origin: "local" },
    });
    const outcome = await service.execute(
      {
        capability: "tool_state",
        action: "set",
        input: { name: "web_search", enabled: true },
        context: { origin: "local" },
      },
      plan,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("does not match");
  });

  it("does not execute remote config writes without an approval adapter", async () => {
    const { service } = createHarness();
    const outcome = await service.execute({
      capability: "config",
      action: "patch",
      input: { patch: { agent: { name: "Remote" } } },
      context: { origin: "mcp" },
    });
    expect(outcome.status).toBe("approval_required");
    expect(outcome.changed).toBe(false);
  });
});
