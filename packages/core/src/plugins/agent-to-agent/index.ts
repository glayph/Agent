import { routeAgentTask, type AgentRouteDecision } from "../../agent-router.js";
import {
  pluginManifest,
  type ManagedPlugin,
  type PluginContext,
  type PluginDescriptor,
  type PluginHealth,
} from "../sdk/index.js";

export interface AgentToAgentPluginRuntime extends ManagedPlugin {
  route(message: string): AgentRouteDecision;
}

class AgentToAgentRuntime implements AgentToAgentPluginRuntime {
  route(message: string): AgentRouteDecision {
    return routeAgentTask(message);
  }

  health(): PluginHealth {
    return {
      ok: true,
      status: "partial",
      message:
        "Specialist routing is available; authenticated delegation transport remains core-owned.",
    };
  }
}

export const agentToAgentPlugin: PluginDescriptor<
  Record<string, never>,
  AgentToAgentPluginRuntime
> = {
  manifest: pluginManifest({
    id: "agent-to-agent.specialist-router",
    displayName: "Agent-to-Agent Specialist Routing",
    version: "1.0.0",
    capabilities: ["agent-to-agent"],
    runtimeStatus: "partial",
    description:
      "Specialist route decisions for multi-agent workflows without untrusted delegation transport.",
    configKey: "agent_to_agent",
    requiredConfig: [],
    secretFields: [],
    permissions: ["agent-delegation"],
    platform: ["any"],
  }),

  create(_context: PluginContext): AgentToAgentPluginRuntime {
    return new AgentToAgentRuntime();
  },
};
