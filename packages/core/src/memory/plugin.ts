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
        backend: "mem0",
        primary: true,
        localPersistence: false,
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
    id: "memory.mem0",
    displayName: "Mem0 Primary Memory",
    version: "1.0.0",
    capabilities: ["memory"],
    runtimeStatus: "functional",
    description:
      "Strict Mem0 primary memory. Conversation history remains session-scoped; no local SQLite/TKG memory is used.",
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
