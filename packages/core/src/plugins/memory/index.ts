import {
  closeMemory,
  getMemory,
  initMemory,
} from "../../memory/memory-bridge.js";
import type { AgentMemoryIntegration } from "../../memory/types.js";
import {
  pluginManifest,
  type ManagedPlugin,
  type PluginContext,
  type PluginDescriptor,
  type PluginHealth,
} from "../sdk/index.js";

export interface MemoryPluginRuntime extends ManagedPlugin {
  readonly memory: AgentMemoryIntegration;
}

class MemoryRuntime implements MemoryPluginRuntime {
  private closed = false;

  constructor(readonly memory: AgentMemoryIntegration) {}

  health(): PluginHealth {
    return {
      ok: !this.closed,
      status: this.closed ? "disabled" : "functional",
      details: { persistent: true, backend: "temporal-knowledge-graph" },
    };
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    closeMemory();
  }
}

export const memoryPlugin: PluginDescriptor<
  Record<string, never>,
  MemoryPluginRuntime
> = {
  manifest: pluginManifest({
    id: "memory.temporal-knowledge-graph",
    displayName: "Temporal Agent Memory",
    version: "1.0.0",
    capabilities: ["memory"],
    runtimeStatus: "functional",
    description:
      "Persistent memory integration with temporal graph retrieval and consolidation.",
    configKey: "memory",
    requiredConfig: [],
    secretFields: [],
    permissions: ["filesystem-read", "filesystem-write"],
    platform: ["any"],
  }),

  create(context: PluginContext): MemoryPluginRuntime {
    const existing =
      context.getService?.<AgentMemoryIntegration>("memory") || getMemory();
    return new MemoryRuntime(existing || initMemory(context.dataDir));
  },
};
