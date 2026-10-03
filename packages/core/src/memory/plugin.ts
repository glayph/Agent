import { closeMemory, getMemory, initMemory } from "./runtime.js";
import type { AgentMemoryIntegration } from "./types.js";
import {
  pluginManifest,
  type ManagedPlugin,
  type PluginContext,
  type PluginDescriptor,
  type PluginHealth,
} from "../plugins/sdk/index.js";

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
      details: {
        persistent: true,
        backend: "local-tkg",
        primary: true,
        localPersistence: true,
      },
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
    id: "memory.local-tkg",
    displayName: "Local TKG Memory",
    version: "1.0.0",
    capabilities: ["memory"],
    runtimeStatus: "functional",
    description:
      "Fully local Temporal Knowledge Graph + graph cognitive memory. File notes and compaction remain in memory-files.",
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
