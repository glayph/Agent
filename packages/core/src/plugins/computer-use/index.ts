import { ComputerAgent } from "./runtime.js";
import {
  pluginManifest,
  type ManagedPlugin,
  type PluginContext,
  type PluginDescriptor,
  type PluginHealth,
} from "../sdk/index.js";

export interface ComputerUsePluginRuntime extends ManagedPlugin {
  readonly computer: ComputerAgent;
}

class ComputerUseRuntime implements ComputerUsePluginRuntime {
  constructor(readonly computer: ComputerAgent) {}

  health(): PluginHealth {
    return {
      ok: true,
      status: "functional",
      details: { platform: process.platform },
    };
  }
}

export const computerUsePlugin: PluginDescriptor<
  Record<string, never>,
  ComputerUsePluginRuntime
> = {
  manifest: pluginManifest({
    id: "computer-use.local",
    displayName: "Computer Use",
    version: "1.0.0",
    capabilities: ["computer-use"],
    runtimeStatus: "functional",
    description:
      "Local desktop observation and control through the existing ComputerAgent.",
    configKey: "computer_use",
    requiredConfig: [],
    secretFields: [],
    permissions: [
      "computer-use",
      "filesystem-read",
      "filesystem-write",
      "shell",
    ],
    platform: ["win32", "linux", "darwin"],
  }),

  create(context: PluginContext): ComputerUsePluginRuntime {
    const injected = context.getService?.<ComputerAgent>("computer");
    return new ComputerUseRuntime(injected || new ComputerAgent());
  },
};
