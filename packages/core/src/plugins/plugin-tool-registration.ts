import type { ToolDefinition } from "../mcp/contracts/tools.js";
import type { ToolRegistry } from "../tools/registry/executor.js";
import {
  executeRuntimePluginTool,
  loadRuntimePluginContracts,
  type RuntimePluginContract,
} from "./plugin-contract-runtime.js";
import { normalizeRuntimePaths, type RuntimePaths } from "../paths.js";

export interface PluginToolRegistrationResult {
  registered: Array<{
    toolName: string;
    pluginName: string;
    contractName: string;
  }>;
  skipped: Array<{
    pluginName: string;
    contractName: string;
    status: string;
    reason: string;
  }>;
}

interface RegisterRuntimePluginToolsOptions {
  skillsDir?: string;
  configPath?: string;
  replaceExisting?: boolean;
}

function safeToolSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]+/g, "_");
  return normalized.replace(/^_+|_+$/g, "") || "tool";
}

export function toolNameForPluginContract(
  contract: Pick<RuntimePluginContract, "plugin" | "contract">,
): string {
  return `plugin_${safeToolSegment(contract.plugin.name)}_${safeToolSegment(
    contract.contract.name,
  )}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parametersForContract(
  contract: RuntimePluginContract,
): Record<string, unknown> {
  const metadata = contract.contract.metadata;
  const candidate = isRecord(metadata)
    ? metadata["parameters"] || metadata["inputSchema"]
    : undefined;
  if (isRecord(candidate)) return candidate;
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

function riskForContract(
  contract: RuntimePluginContract,
): ToolDefinition["risk"] {
  const level = contract.readiness.risk.level;
  return {
    level,
    label: `${level[0].toUpperCase()}${level.slice(1)} risk`,
    reason:
      contract.permissions.length > 0
        ? `Plugin contract requests: ${contract.permissions.join(", ")}.`
        : "Plugin contract does not declare elevated permissions.",
  };
}

function definitionForContract(
  toolName: string,
  contract: RuntimePluginContract,
): ToolDefinition {
  return {
    type: "function",
    risk: riskForContract(contract),
    function: {
      name: toolName,
      description:
        contract.contract.description ||
        `Run plugin tool ${contract.plugin.name}:${contract.contract.name}.`,
      parameters: parametersForContract(contract),
    },
  };
}

export async function registerRuntimePluginTools(
  registry: ToolRegistry,
  paths: RuntimePaths | string,
  options: RegisterRuntimePluginToolsOptions = {},
): Promise<PluginToolRegistrationResult> {
  const runtimePaths = normalizeRuntimePaths(paths);
  if (options.replaceExisting) {
    registry.clearPluginTools();
  }

  const contracts = await loadRuntimePluginContracts(runtimePaths, {
    skillsDir: options.skillsDir,
    configPath: options.configPath,
    kind: "tools",
  });

  const result: PluginToolRegistrationResult = {
    registered: [],
    skipped: [],
  };

  for (const contract of contracts) {
    const toolName = toolNameForPluginContract(contract);
    if (registry.hasTool(toolName)) {
      result.skipped.push({
        pluginName: contract.plugin.name,
        contractName: contract.contract.name,
        status: "duplicate",
        reason: `Tool "${toolName}" is already registered.`,
      });
      continue;
    }
    if (
      contract.readiness.status !== "ready" ||
      !contract.readiness.executable
    ) {
      result.skipped.push({
        pluginName: contract.plugin.name,
        contractName: contract.contract.name,
        status: contract.readiness.status,
        reason:
          contract.readiness.reasons.join(" ") ||
          "Plugin tool contract is not executable.",
      });
      continue;
    }

    registry.registerPluginTool(
      toolName,
      async (args) => {
        const execution = await executeRuntimePluginTool(
          runtimePaths.sourceDir ?? runtimePaths.configDir,
          `${contract.plugin.name}:${contract.contract.name}`,
          args,
          {
            skillsDir: options.skillsDir,
            configPath: options.configPath,
          },
        );
        if (!execution.success) {
          return `Plugin Error: ${execution.error || "unknown error"}`;
        }
        return execution.output || "";
      },
      definitionForContract(toolName, contract),
    );

    result.registered.push({
      toolName,
      pluginName: contract.plugin.name,
      contractName: contract.contract.name,
    });
  }

  return result;
}
