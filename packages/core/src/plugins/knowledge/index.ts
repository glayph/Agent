import * as memoryBridge from "../../memory/memory-bridge.js";
import {
  pluginManifest,
  type ManagedPlugin,
  type PluginContext,
  type PluginDescriptor,
  type PluginHealth,
} from "../sdk/index.js";

export interface KnowledgePluginRuntime extends ManagedPlugin {
  retrieve(query: string, options?: Record<string, unknown>): unknown;
  multiHop(options?: Record<string, unknown>): unknown;
  graph(query: string, limit?: number): unknown[];
  snapshot(limit?: number): unknown;
}

class KnowledgeRuntime implements KnowledgePluginRuntime {
  retrieve(query: string, options: Record<string, unknown> = {}): unknown {
    return typeof memoryBridge.getSelectiveContext === "function"
      ? memoryBridge.getSelectiveContext(query, options)
      : {
          items: [],
          text: "",
          trace: {},
          stats: { fallbackReason: "memory_bridge_unavailable" },
        };
  }

  multiHop(options: Record<string, unknown> = {}): unknown {
    return typeof memoryBridge.multiHopRetrieve === "function"
      ? memoryBridge.multiHopRetrieve(options)
      : {
          hops: [],
          nodes: [],
          edges: [],
          analysis: "memory_bridge_unavailable",
        };
  }

  graph(query: string, limit = 8): unknown[] {
    return typeof memoryBridge.getNodeGraphContext === "function"
      ? memoryBridge.getNodeGraphContext(query, limit)
      : [];
  }

  snapshot(limit = 100): unknown {
    return typeof memoryBridge.getNodeGraphSnapshot === "function"
      ? memoryBridge.getNodeGraphSnapshot(limit)
      : { nodes: [], edges: [] };
  }

  health(): PluginHealth {
    return {
      ok: true,
      status: "functional",
      details: { backend: "memory-tkg" },
    };
  }
}

export const knowledgePlugin: PluginDescriptor<
  Record<string, never>,
  KnowledgePluginRuntime
> = {
  manifest: pluginManifest({
    id: "knowledge.memory-retrieval",
    displayName: "Knowledge and RAG Retrieval",
    version: "1.0.0",
    capabilities: ["knowledge"],
    runtimeStatus: "functional",
    description:
      "Selective context, multi-hop retrieval, and graph context over Agent Memory.",
    configKey: "knowledge",
    requiredConfig: [],
    secretFields: [],
    permissions: ["filesystem-read"],
    platform: ["any"],
  }),

  create(_context: PluginContext): KnowledgePluginRuntime {
    return new KnowledgeRuntime();
  },
};
