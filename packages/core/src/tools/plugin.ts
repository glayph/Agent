import { ToolRegistry } from "./registry/executor.js";
import type { ToolDefinition } from "../mcp/contracts/tools.js";
import {
  pluginManifest,
  type ManagedPlugin,
  type PluginContext,
  type PluginDescriptor,
  type PluginHealth,
} from "../plugins/sdk/index.js";

export interface ToolsPluginRuntime extends ManagedPlugin {
  readonly registry?: ToolRegistry;
  definitions(): ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}

class ToolsRuntime implements ToolsPluginRuntime {
  constructor(readonly registry?: ToolRegistry) {}

  definitions(): ToolDefinition[] {
    return this.registry?.getToolDefinitions() || [];
  }

  execute(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.registry) {
      return Promise.resolve(
        "Tool registry is not attached to the core policy context.",
      );
    }
    return this.registry.executeTool(name, args);
  }

  health(): PluginHealth {
    return this.registry
      ? {
          ok: true,
          status: "functional",
          details: { tools: this.definitions().length },
        }
      : {
          ok: false,
          status: "partial",
          message: "ToolRegistry must be injected by Agent Core.",
        };
  }
}

export const toolsPlugin: PluginDescriptor<
  Record<string, never>,
  ToolsPluginRuntime
> = {
  manifest: pluginManifest({
    id: "tools.core-registry",
    displayName: "Tool Registry",
    version: "1.0.0",
    capabilities: ["tool"],
    runtimeStatus: "functional",
    description:
      "Built-in and external tool registration with timeout, permission, and risk enforcement.",
    configKey: "tools",
    requiredConfig: [],
    secretFields: [],
    permissions: [
      "filesystem-read",
      "filesystem-write",
      "network",
      "shell",
      "browser",
      "computer-use",
    ],
    platform: ["any"],
  }),

  create(context: PluginContext): ToolsPluginRuntime {
    return new ToolsRuntime(context.getService?.<ToolRegistry>("toolRegistry"));
  },
};
