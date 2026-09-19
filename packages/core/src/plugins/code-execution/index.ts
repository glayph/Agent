import {
  RuntimeFetcher,
  type EnsureRuntimeOutcome,
  type RuntimeRequirement,
} from "../../runtime-fetch/index.js";
import {
  pluginManifest,
  type ManagedPlugin,
  type PluginContext,
  type PluginDescriptor,
  type PluginHealth,
} from "../sdk/index.js";

export interface CodeExecutionPluginRuntime extends ManagedPlugin {
  readonly fetcher?: RuntimeFetcher;
  ensureRuntimeReady(
    skillId: string,
    requirement: RuntimeRequirement,
  ): Promise<EnsureRuntimeOutcome>;
}

class CodeExecutionRuntime implements CodeExecutionPluginRuntime {
  constructor(readonly fetcher?: RuntimeFetcher) {}

  async ensureRuntimeReady(
    skillId: string,
    requirement: RuntimeRequirement,
  ): Promise<EnsureRuntimeOutcome> {
    if (!this.fetcher) {
      return {
        outcome: "failed",
        error:
          "Code execution runtime is not attached to the core policy context.",
      };
    }
    return this.fetcher.ensureRuntimeReady(skillId, requirement);
  }

  health(): PluginHealth {
    return this.fetcher
      ? { ok: true, status: "functional", details: { approvalGated: true } }
      : {
          ok: false,
          status: "partial",
          message: "RuntimeFetcher must be injected by the core ToolRegistry.",
        };
  }
}

export const codeExecutionPlugin: PluginDescriptor<
  Record<string, never>,
  CodeExecutionPluginRuntime
> = {
  manifest: pluginManifest({
    id: "code-execution.runtime-fetch",
    displayName: "Approval-Gated Code Execution",
    version: "1.0.0",
    capabilities: ["code-execution"],
    runtimeStatus: "functional",
    description:
      "Language runtime installation and execution prerequisites with consent and sandbox policy.",
    configKey: "runtime_installer",
    requiredConfig: [],
    secretFields: [],
    permissions: ["filesystem-write", "network", "shell"],
    platform: ["win32", "linux", "darwin"],
  }),

  create(context: PluginContext): CodeExecutionPluginRuntime {
    return new CodeExecutionRuntime(
      context.getService?.<RuntimeFetcher>("runtimeFetcher"),
    );
  },
};
