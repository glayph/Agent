import {
  getLocalRuntimeHealth,
  isLocalModel,
  synchronizeLocalRuntimeForModel,
  type LocalRuntimeHealth,
} from "../llm/local/local-runtime.js";

export interface ModelRuntimeDescriptor {
  [key: string]: unknown;
  id: string;
  provider: string;
  model?: string;
  installed: boolean;
  active: boolean;
  compatible: boolean;
  health?: LocalRuntimeHealth | Record<string, unknown>;
  limitations: string[];
}

export interface ModelRuntimeAdapter {
  id: string;
  provider: string;
  inspect(
    model?: string,
  ): Promise<ModelRuntimeDescriptor> | ModelRuntimeDescriptor;
  activate(model: string): Promise<ModelRuntimeDescriptor>;
  health(
    model?: string,
  ): Promise<ModelRuntimeDescriptor> | ModelRuntimeDescriptor;
  install?: (input: Record<string, unknown>) => Promise<ModelRuntimeDescriptor>;
  remove?: (model: string) => Promise<{ removed: boolean; reason?: string }>;
}

export function createLlamaCppAdapter(): ModelRuntimeAdapter {
  const inspect = (model?: string): ModelRuntimeDescriptor => {
    const health = getLocalRuntimeHealth(model);
    const local = model ? isLocalModel(model) : health.configured;
    return {
      id: "llama.cpp",
      provider: "llama.cpp",
      model,
      installed: Boolean(health.model_path),
      active: health.ready,
      compatible: local,
      health,
      limitations: [
        "The runtime uses operator-provided llama-server and GGUF files.",
        "General model download and native dependency installation are not implemented by this adapter.",
      ],
    };
  };

  return {
    id: "llama.cpp",
    provider: "llama.cpp",
    inspect,
    health: inspect,
    activate: async (model) => {
      const transition = await synchronizeLocalRuntimeForModel(model);
      return {
        ...inspect(model),
        active:
          transition.action === "started" ||
          transition.action === "already_ready",
        health: transition.health,
        limitations: transition.error
          ? [transition.error]
          : inspect(model).limitations,
      };
    },
  };
}
