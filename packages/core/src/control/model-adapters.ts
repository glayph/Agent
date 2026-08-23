import {
  getLocalRuntimeHealth,
  isLocalModel,
  synchronizeLocalRuntimeForModel,
  type LocalRuntimeHealth,
} from "../llm/local/local-runtime.js";
import { VoiceRuntimeManager } from "../voice-runtime.js";
import type { RuntimePaths } from "../paths.js";

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

export function createVoiceRuntimeAdapter(
  runtimePaths: RuntimePaths,
): ModelRuntimeAdapter {
  const manager = new VoiceRuntimeManager(runtimePaths);
  const inspect = (): ModelRuntimeDescriptor => {
    const status = manager.status();
    return {
      id: "voice.local",
      provider: "whisper.cpp",
      model: status.activeModelId || undefined,
      installed: status.installed,
      active: status.healthy,
      compatible: status.transport === "cli" || status.transport === "endpoint",
      health: { ...status },
      limitations:
        status.reason === "Local voice-to-text model is installed and ready."
          ? []
          : [status.reason],
    };
  };
  return {
    id: "voice.local",
    provider: "whisper.cpp",
    inspect,
    health: async () => {
      await manager.health();
      return inspect();
    },
    activate: async (model) => {
      await manager.activate(model);
      return inspect();
    },
    install: async (input) => {
      const model =
        typeof input.model_id === "string" ? input.model_id : input.model;
      if (typeof model !== "string" || !model.trim())
        throw new Error("Voice model_id is required.");
      await manager.install(model);
      return inspect();
    },
    remove: async (model) => {
      await manager.remove(model);
      return { removed: true };
    },
  };
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
