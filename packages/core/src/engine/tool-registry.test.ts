import { resolveToolApproval, ToolRegistry } from "./tool-registry.js";
import type { EngineTool } from "./types.js";

const tool = (overrides: Partial<EngineTool> = {}): EngineTool => ({
  name: "demo_action", description: "demo", risk: "config_write",
  parameters: { type: "object", properties: {} }, execute: () => ({ ok: true }),
  ...overrides,
});

describe("resolveToolApproval", () => {
  it("lets a trusted autonomous policy run routine required tools", () => {
    expect(resolveToolApproval(tool({ approval: "required" }), {}, { mode: "auto", reason: "allowlisted" }).mode).toBe("auto");
    expect(resolveToolApproval(tool({ approval: "required", risk: "destructive" }), {}, { mode: "auto", reason: "allowlisted" }).mode).toBe("approval");
  });

  it("keeps explicit auto tools automatic unless a runtime escalation applies", () => {
    expect(resolveToolApproval(tool({ approval: "auto" })).mode).toBe("auto");
    expect(resolveToolApproval(tool({ approval: "auto" }), { requireConfirmDestructive: true }, undefined, undefined).mode).toBe("auto");
    expect(resolveToolApproval(tool({ name: "computer_click", approval: "auto" }), { requireConfirmComputerUse: true }).mode).toBe("approval");
  });

  it("escalates destructive classes when configured", () => {
    expect(resolveToolApproval(tool({ risk: "destructive", approval: "auto" }), { requireConfirmDestructive: true }).mode).toBe("approval");
  });

  it("fails closed when unrestricted access lacks an explicit risk and audit acknowledgement", () => {
    expect(resolveToolApproval(tool({ approval: "auto" }), { unrestrictedMode: true, securityAcknowledged: false }).mode).toBe("block");
    expect(resolveToolApproval(tool({ approval: "auto" }), { unrestrictedMode: true, securityAcknowledged: true }).mode).toBe("auto");
  });

  it("auto-approves every registered tool when sandbox owner mode is enabled", () => {
    expect(resolveToolApproval(
      tool({ risk: "destructive", approval: "required" }),
      { autoApproveAll: true, requireConfirmDestructive: true, requireConfirmComputerUse: true },
      { mode: "approval", reason: "high risk" },
      { mode: "approval", reason: "learned ask" },
    )).toMatchObject({ mode: "auto" });
  });

  it("lets hard blocks win over approval or auto decisions", () => {
    expect(resolveToolApproval(tool(), { autoApproveAll: true }, { mode: "auto", reason: "allowed" }, { mode: "block", reason: "learned block" })).toMatchObject({ mode: "block", reason: "learned block" });
    expect(resolveToolApproval(tool(), { autoApproveAll: true }, { mode: "block", reason: "policy block" })).toMatchObject({ mode: "block", reason: "policy block" });
  });

  it("requires approval for non-read calls without an explicit auto decision", () => {
    expect(resolveToolApproval(tool())).toMatchObject({ mode: "approval" });
    expect(resolveToolApproval(tool({ risk: "read" }))).toMatchObject({ mode: "auto" });
    expect(resolveToolApproval(tool({ risk: "read" }), { autoApproveSafe: false })).toMatchObject({ mode: "approval" });
    expect(resolveToolApproval(tool({ risk: "read", approval: "auto" }), { autoApproveSafe: false }).mode).toBe("approval");
    expect(resolveToolApproval(tool({ risk: "read" }), { autoApproveSafe: false }, { mode: "auto", reason: "policy allow" }).mode).toBe("approval");
  });

  it("attaches distinct trusted monitor presentation metadata when tools are registered", () => {
    const registry = new ToolRegistry()
    registry.register(tool({ name: "browser_navigate" }))
    registry.register(tool({ name: "computer_observe" }))
    registry.register(tool({ name: "terminal_execute" }))
    registry.register(tool({ name: "workspace_list" }))
    registry.register(tool({ name: "web_search" }))
    expect(registry.get("browser_navigate")?.monitor).toMatchObject({ category: "browser", iconKey: "browser" })
    expect(registry.get("computer_observe")?.monitor).toMatchObject({ category: "computer", iconKey: "computer" })
    expect(registry.get("terminal_execute")?.monitor).toMatchObject({ category: "terminal", iconKey: "terminal" })
    expect(registry.get("workspace_list")?.monitor).toMatchObject({ category: "file", iconKey: "file" })
    expect(registry.get("web_search")?.monitor).toMatchObject({ category: "search", iconKey: "search" })
  })

  it("preserves explicitly registered plugin or provider presentation metadata", () => {
    const registry = new ToolRegistry()
    registry.register(tool({ name: "plugin_invoke", monitor: { category: "plugin", iconKey: "github", displayName: "GitHub", pluginId: "github" } }))
    expect(registry.get("plugin_invoke")?.monitor).toMatchObject({ category: "plugin", iconKey: "github", displayName: "GitHub", pluginId: "github" })
  })

  it("keeps ToolRegistry.needsApproval consistent with the fallback rule", () => {
    expect(ToolRegistry.needsApproval(tool({ risk: "read" }))).toBe(false);
    expect(ToolRegistry.needsApproval(tool({ risk: "config_write" }))).toBe(true);
  });
});
