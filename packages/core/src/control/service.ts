import * as path from "path";
import { randomUUID } from "crypto";
import type {
  AgentControlServiceOptions,
  ControlApprovalRequest,
  ControlCapabilityDescriptor,
  ControlContext,
  ControlEvidence,
  ControlOperationRequest,
  ControlOutcome,
  ControlPlan,
  ControlRisk,
  ModelRuntimeAdapterLike,
  ControlStep,
  LauncherAdminControllerLike,
} from "./types.js";
import { ControlJournal } from "./journal.js";

const DEFAULT_ALLOWED_CONFIG_PREFIXES = [
  "agent.name",
  "agent.project",
  "agent.persona",
  "agent.language",
  "agent.timezone",
  "agent.max_tokens_per_cycle",
  "agent.browser",
  "agent.resource",
  "agent.memory",
  "memory",
  "web_search",
  "speech_to_text",
  "tools.mcp.discovery",
  "tools.exec.enabled",
  "tools.exec.allow_remote",
  "tools.cron.allow_command",
  "tools.cron.exec_timeout_minutes",
  "heartbeat",
  "concurrency",
];

const READ_ONLY_CAPABILITIES: ControlCapabilityDescriptor[] = [
  {
    id: "capabilities",
    label: "Capability inventory",
    description: "List the management operations available in this runtime.",
    risk: "read",
    platforms: ["all"],
    readOnly: true,
    actions: ["list"],
    supportsApproval: false,
    limitations: [],
  },
  {
    id: "system_state",
    label: "Sanitized system state",
    description:
      "Inspect current configuration, tool state, runtime, and control status.",
    risk: "read",
    platforms: ["all"],
    readOnly: true,
    actions: ["inspect"],
    supportsApproval: false,
    limitations: ["Secrets and raw credentials are never returned."],
  },
  {
    id: "model_runtime",
    label: "Model/runtime management",
    description:
      "Inspect and activate configured model runtimes through provider adapters.",
    risk: "service",
    platforms: ["all"],
    readOnly: false,
    actions: ["inspect", "activate", "health", "install", "remove"],
    supportsApproval: true,
    limitations: [
      "Only registered adapters can perform an operation; installation/removal remains approval-gated.",
    ],
  },
  {
    id: "model_selection",
    label: "Active model selection",
    description:
      "Select a configured model through the launcher’s existing persistence and runtime synchronization path.",
    risk: "config_write",
    platforms: ["all"],
    readOnly: false,
    actions: ["set"],
    supportsApproval: true,
    limitations: [
      "The model must already be configured or supported by the launcher catalog.",
    ],
  },
  {
    id: "models",
    label: "Model state",
    description:
      "Inspect configured model entries and the selected model without exposing credentials.",
    risk: "read",
    platforms: ["all"],
    readOnly: true,
    actions: ["inspect"],
    supportsApproval: false,
    limitations: [
      "General model download and installation require a runtime adapter and explicit approval.",
    ],
  },
];

const MUTABLE_CAPABILITIES: ControlCapabilityDescriptor[] = [
  {
    id: "config",
    label: "Supported runtime configuration",
    description:
      "Preview and apply a narrow, schema-validated configuration patch.",
    risk: "config_write",
    platforms: ["all"],
    readOnly: false,
    actions: ["preview", "patch"],
    supportsApproval: true,
    limitations: [
      "Arbitrary paths, credentials, factory reset, and destructive fields are excluded.",
    ],
  },
  {
    id: "tool_state",
    label: "Tool enablement",
    description:
      "Enable or disable an existing registered tool through the dashboard-backed state.",
    risk: "config_write",
    platforms: ["all"],
    readOnly: false,
    actions: ["set"],
    supportsApproval: true,
    limitations: [
      "This does not grant new filesystem, shell, browser, or destructive permissions.",
    ],
  },
  {
    id: "runtime",
    label: "Runtime reload",
    description:
      "Reload supported runtime configuration and report whether a full restart remains necessary.",
    risk: "service",
    platforms: ["all"],
    readOnly: false,
    actions: ["reload"],
    supportsApproval: true,
    limitations: [
      "Full process/service control is intentionally not a generic agent operation.",
    ],
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sanitize(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
  if (!isRecord(value)) {
    if (
      typeof value === "string" &&
      /(api[_-]?key|token|secret|password|credential|authorization)/i.test(key)
    ) {
      return value ? "[REDACTED]" : "";
    }
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (
      /(api[_-]?key|token|secret|password|credential|authorization)/i.test(
        entryKey,
      )
    ) {
      output[entryKey] = entryValue ? "[REDACTED]" : "";
    } else {
      output[entryKey] = sanitize(entryValue, entryKey);
    }
  }
  return output;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function flattenPaths(value: unknown, prefix = ""): string[] {
  if (!isRecord(value)) return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, child]) => {
    const next = prefix ? `${prefix}.${key}` : key;
    return isRecord(child) ? flattenPaths(child, next) : [next];
  });
}

function matchesAllowedPrefix(pathName: string, prefixes: string[]): boolean {
  return prefixes.some(
    (prefix) => pathName === prefix || pathName.startsWith(`${prefix}.`),
  );
}

function safeInput(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return (sanitize(input || {}) || {}) as Record<string, unknown>;
}

function contextFrom(request: ControlOperationRequest): ControlContext {
  return {
    origin: request.context?.origin || "local",
    actor: request.context?.actor,
    requestId: request.context?.requestId,
    sessionId: request.context?.sessionId,
    workspaceDir: request.context?.workspaceDir,
  };
}

export class AgentControlService {
  private readonly controller: LauncherAdminControllerLike;
  private readonly journal: ControlJournal;
  private readonly hooks: NonNullable<AgentControlServiceOptions["hooks"]>;
  private readonly approvals: NonNullable<
    AgentControlServiceOptions["approvals"]
  >;
  private readonly allowedConfigPrefixes: string[];
  private readonly modelAdapters: ModelRuntimeAdapterLike[];

  constructor(options: AgentControlServiceOptions) {
    this.controller = options.controller;
    this.journal = new ControlJournal(
      path.join(options.runtimePaths.dataDir, "control-operations.json"),
    );
    this.hooks = options.hooks || {};
    this.approvals = options.approvals || {};
    this.allowedConfigPrefixes =
      options.allowedConfigPrefixes || DEFAULT_ALLOWED_CONFIG_PREFIXES;
    this.modelAdapters = options.modelAdapters || [];
  }

  listCapabilities(): ControlCapabilityDescriptor[] {
    return clone([...READ_ONLY_CAPABILITIES, ...MUTABLE_CAPABILITIES]);
  }

  listOperations(limit = 20): ReturnType<ControlJournal["list"]> {
    return this.journal.list(limit);
  }

  getState(): Record<string, unknown> {
    const config = sanitize(this.controller.getConfig()) as Record<
      string,
      unknown
    >;
    const tools = isRecord(config.tools) ? config.tools : {};
    const toolState = isRecord(tools.tool_state) ? tools.tool_state : {};
    const extra = this.hooks.readExtraState ? this.hooks.readExtraState() : {};
    return {
      config,
      tool_state: sanitize(toolState),
      runtime: sanitize(extra),
      control: {
        journal_entries: this.journal.list(20).length,
        platform: process.platform,
        node: process.version,
      },
    };
  }

  previewConfigPatch(patch: Record<string, unknown>): {
    valid: boolean;
    unsupported_paths: string[];
    validation: Record<string, unknown>;
    sanitized_patch: Record<string, unknown>;
  } {
    const paths = flattenPaths(patch);
    const unsupported = paths.filter(
      (entry) => !matchesAllowedPrefix(entry, this.allowedConfigPrefixes),
    );
    const validation = this.controller.validatePatch(patch);
    return {
      valid: unsupported.length === 0 && validation.valid === true,
      unsupported_paths: unsupported,
      validation: sanitize(validation) as Record<string, unknown>,
      sanitized_patch: safeInput(patch),
    };
  }

  async plan(request: ControlOperationRequest): Promise<ControlPlan> {
    const operationId = randomUUID();
    const input = request.input || {};
    const descriptor = this.listCapabilities().find(
      (item) => item.id === request.capability,
    );
    if (!descriptor || !descriptor.actions.includes(request.action)) {
      return {
        operationId,
        capability: request.capability,
        action: request.action,
        risk: "read",
        status: "failed",
        idempotent: false,
        approvalRequired: false,
        sanitizedInput: safeInput(input),
        steps: [],
        evidence: [
          {
            id: "unsupported-capability",
            kind: "error",
            summary: "Unsupported control capability or action.",
            ok: false,
          },
        ],
        createdAt: new Date().toISOString(),
      };
    }

    const risk = descriptor.risk;
    const approvalRequired = this.requiresApproval(
      risk,
      contextFrom(request),
      request.capability,
      request.action,
    );
    const steps: ControlStep[] = [
      {
        id: `${operationId}:inspect`,
        title: "Inspect current state",
        capability: request.capability,
        action: "inspect",
        risk: "read",
        status: "pending",
      },
    ];
    if (request.capability === "config" && request.action === "patch") {
      steps.push({
        id: `${operationId}:validate`,
        title: "Validate supported configuration paths",
        capability: request.capability,
        action: request.action,
        risk,
        status: "pending",
      });
    }
    if (
      request.capability === "tool_state" ||
      request.action === "patch" ||
      request.action === "reload" ||
      (request.capability === "model_runtime" &&
        ["activate", "install", "remove"].includes(request.action)) ||
      (request.capability === "model_selection" && request.action === "set")
    ) {
      steps.push({
        id: `${operationId}:apply`,
        title: approvalRequired
          ? "Apply after owner approval"
          : "Apply validated operation",
        capability: request.capability,
        action: request.action,
        risk,
        status: "pending",
      });
    }
    steps.push({
      id: `${operationId}:verify`,
      title: "Verify resulting state",
      capability: request.capability,
      action: "verify",
      risk: "read",
      status: "pending",
    });

    const plan: ControlPlan = {
      operationId,
      capability: request.capability,
      action: request.action,
      risk,
      status: approvalRequired ? "approval_required" : "planned",
      idempotent: request.action !== "reload",
      approvalRequired,
      sanitizedInput: safeInput(input),
      steps,
      evidence: [
        {
          id: `${operationId}:plan`,
          kind: "state",
          summary: "Plan created from the current runtime state.",
          ok: true,
        },
      ],
      createdAt: new Date().toISOString(),
    };
    this.journal.append({
      operationId,
      status: plan.status,
      capability: plan.capability,
      action: plan.action,
      risk: plan.risk,
      input: plan.sanitizedInput,
      at: plan.createdAt,
    });
    return plan;
  }

  async execute(
    request: ControlOperationRequest,
    existingPlan?: ControlPlan,
  ): Promise<ControlOutcome> {
    const plan = existingPlan || (await this.plan(request));
    if (
      existingPlan &&
      (plan.capability !== request.capability ||
        plan.action !== request.action ||
        JSON.stringify(plan.sanitizedInput) !==
          JSON.stringify(safeInput(request.input)))
    ) {
      return this.failure(
        plan,
        "The supplied control plan does not match the current operation request.",
      );
    }
    const context = contextFrom(request);
    const completedAt = () => new Date().toISOString();
    if (plan.status === "failed")
      return this.failure(
        plan,
        "Cannot execute an unsupported control operation.",
      );
    if (plan.approvalRequired && !(await this.isApproved(request, plan))) {
      const approval = this.approvals.requestApproval
        ? await this.approvals.requestApproval({
            operationId: plan.operationId,
            capability: plan.capability,
            action: plan.action,
            risk: plan.risk,
            reason: `Agent control operation ${plan.capability}.${plan.action} requires approval.`,
            sanitizedInput: plan.sanitizedInput,
            context,
          })
        : undefined;
      this.journal.append({
        operationId: plan.operationId,
        status: "approval_required",
        capability: plan.capability,
        action: plan.action,
        risk: plan.risk,
        input: plan.sanitizedInput,
        at: completedAt(),
        approval_request_id: approval?.requestId,
      });
      return {
        operationId: plan.operationId,
        status: "approval_required",
        ok: false,
        changed: false,
        approvalRequired: true,
        pendingRestart: false,
        capability: plan.capability,
        action: plan.action,
        evidence: [
          {
            id: "approval",
            kind: "approval",
            summary: approval
              ? "Owner approval is required before execution."
              : "Operation is blocked until an approval adapter is configured.",
            ok: false,
            data: approval ? { request_id: approval.requestId } : undefined,
          },
        ],
        completedAt: completedAt(),
      };
    }

    if (plan.approvalRequired && this.approvals.consumeApproval) {
      if (!request.approvalRequestId)
        return this.failure(
          plan,
          "An approved control request id is required before this operation can execute.",
        );
      const approvalRequest: ControlApprovalRequest = {
        operationId: plan.operationId,
        capability: plan.capability,
        action: plan.action,
        risk: plan.risk,
        reason: "Approved control operation",
        sanitizedInput: plan.sanitizedInput,
        context,
        approvalRequestId: request.approvalRequestId,
      };
      if (
        !(await this.approvals.consumeApproval(
          approvalRequest,
          request.approvalRequestId,
        ))
      ) {
        return this.failure(
          plan,
          "The approval request could not be consumed for this operation context.",
        );
      }
    }

    const evidence: ControlEvidence[] = [...plan.evidence];
    let changed = false;
    let pendingRestart = false;
    try {
      const before = this.getState();
      evidence.push({
        id: "before",
        kind: "state",
        summary: "Current state inspected before mutation.",
        ok: true,
        data: sanitize(before) as Record<string, unknown>,
      });
      if (plan.capability === "capabilities" && plan.action === "list") {
        return {
          operationId: plan.operationId,
          status: "succeeded",
          ok: true,
          changed: false,
          approvalRequired: false,
          pendingRestart: false,
          capability: plan.capability,
          action: plan.action,
          state: { capabilities: this.listCapabilities() },
          evidence,
          completedAt: completedAt(),
        };
      }
      if (
        plan.capability === "model_runtime" &&
        (plan.action === "inspect" || plan.action === "health")
      ) {
        const adapter = this.findModelAdapter(request.input);
        if (!adapter)
          throw new Error(
            "No model/runtime adapter is registered for the requested provider.",
          );
        const model = stringValue(request.input?.model) || undefined;
        const state =
          plan.action === "inspect"
            ? await adapter.inspect(model)
            : await adapter.health(model);
        evidence.push({
          id: "model-health",
          kind: "probe",
          summary: "Model/runtime adapter state inspected.",
          ok: true,
          data: sanitize(state) as Record<string, unknown>,
        });
        return {
          operationId: plan.operationId,
          status: "succeeded",
          ok: true,
          changed: false,
          approvalRequired: false,
          pendingRestart: false,
          capability: plan.capability,
          action: plan.action,
          state: sanitize(state) as Record<string, unknown>,
          evidence,
          completedAt: completedAt(),
        };
      }
      if (
        plan.capability === "model_runtime" &&
        (plan.action === "activate" ||
          plan.action === "install" ||
          plan.action === "remove")
      ) {
        const adapter = this.findModelAdapter(request.input);
        if (!adapter)
          throw new Error(
            "No model/runtime adapter is registered for the requested provider.",
          );
        if (plan.action === "activate") {
          const model = stringValue(request.input?.model);
          if (!model)
            throw new Error("model_runtime.activate requires a model.");
          const state = await adapter.activate(model);
          changed = true;
          pendingRestart = Boolean(state.pending_restart);
          evidence.push({
            id: "model-activate",
            kind: "probe",
            summary:
              "Model/runtime activation completed through the registered adapter.",
            ok: true,
            data: sanitize(state) as Record<string, unknown>,
          });
        } else if (plan.action === "install") {
          if (!adapter.install)
            throw new Error(
              "This model/runtime adapter does not implement installation.",
            );
          const state = await adapter.install(request.input || {});
          changed = true;
          evidence.push({
            id: "model-install",
            kind: "probe",
            summary:
              "Model/runtime installation completed through the registered adapter.",
            ok: true,
            data: sanitize(state) as Record<string, unknown>,
          });
        } else {
          if (!adapter.remove)
            throw new Error(
              "This model/runtime adapter does not implement removal.",
            );
          const model = stringValue(request.input?.model);
          if (!model) throw new Error("model_runtime.remove requires a model.");
          const state = await adapter.remove(model);
          changed = state.removed === true;
          evidence.push({
            id: "model-remove",
            kind: "probe",
            summary:
              "Model/runtime removal result returned by the registered adapter.",
            ok: true,
            data: sanitize(state) as Record<string, unknown>,
          });
        }
      } else if (
        (plan.capability === "system_state" || plan.capability === "models") &&
        plan.action === "inspect"
      ) {
        const state = this.getState();
        const stateConfig = isRecord(state.config) ? state.config : {};
        return {
          operationId: plan.operationId,
          status: "succeeded",
          ok: true,
          changed: false,
          approvalRequired: false,
          pendingRestart: false,
          capability: plan.capability,
          action: plan.action,
          state:
            plan.capability === "models"
              ? {
                  models: stateConfig.models,
                  model_providers: stateConfig.model_providers,
                }
              : state,
          evidence,
          completedAt: completedAt(),
        };
      }
      if (plan.capability === "model_selection" && plan.action === "set") {
        const model = stringValue(request.input?.model);
        if (!model) throw new Error("model_selection.set requires a model.");
        if (!this.controller.setActiveModel)
          throw new Error(
            "Active model selection is not available in this launcher.",
          );
        const result = await this.controller.setActiveModel(model);
        changed = true;
        pendingRestart =
          result.gateway_restart_required === true ||
          result.runtime_apply_status === "pending_restart";
        evidence.push({
          id: "model-selection",
          kind: "validation",
          summary:
            "Active model selected through the shared launcher controller.",
          ok: true,
          data: sanitize(result) as Record<string, unknown>,
        });
      }
      if (plan.capability === "config" && plan.action === "preview") {
        const patch = isRecord(request.input?.patch)
          ? (request.input!.patch as Record<string, unknown>)
          : {};
        const preview = this.previewConfigPatch(patch);
        evidence.push({
          id: "validation",
          kind: "validation",
          summary: preview.valid
            ? "Configuration patch is supported and valid."
            : "Configuration patch is not valid for autonomous control.",
          ok: preview.valid,
          data: preview,
        });
        return {
          operationId: plan.operationId,
          status: preview.valid ? "succeeded" : "failed",
          ok: preview.valid,
          changed: false,
          approvalRequired: false,
          pendingRestart: false,
          capability: plan.capability,
          action: plan.action,
          state: preview,
          evidence,
          error: preview.valid ? undefined : "Configuration preview failed.",
          completedAt: completedAt(),
        };
      }
      if (plan.capability === "config" && plan.action === "patch") {
        const patch = isRecord(request.input?.patch)
          ? (request.input!.patch as Record<string, unknown>)
          : {};
        const preview = this.previewConfigPatch(patch);
        if (!preview.valid)
          return {
            operationId: plan.operationId,
            status: "failed",
            ok: false,
            changed: false,
            approvalRequired: false,
            pendingRestart: false,
            capability: plan.capability,
            action: plan.action,
            state: preview,
            evidence,
            error:
              "Configuration patch failed validation or contains unsupported paths.",
            completedAt: completedAt(),
          };
        const result = await this.controller.applyPatch(
          patch,
          `agent.control.${context.origin}`,
        );
        changed = true;
        pendingRestart =
          result.gateway_restart_required === true ||
          result.runtime_apply_status === "pending_restart";
        evidence.push({
          id: "apply",
          kind: "validation",
          summary:
            "Validated configuration patch applied through the shared dashboard controller.",
          ok: true,
          data: sanitize(result) as Record<string, unknown>,
        });
      } else if (plan.capability === "tool_state" && plan.action === "set") {
        const name = stringValue(request.input?.name);
        const enabled = booleanValue(request.input?.enabled);
        if (!name || enabled === undefined)
          throw new Error("tool_state.set requires name and boolean enabled");
        const result = await this.controller.setToolState(name, enabled);
        changed = true;
        pendingRestart =
          result.gateway_restart_required === true ||
          result.runtime_apply_status === "pending_restart";
        evidence.push({
          id: "apply",
          kind: "validation",
          summary: `Tool state updated for ${name}.`,
          ok: true,
          data: sanitize(result) as Record<string, unknown>,
        });
      } else if (plan.capability === "runtime" && plan.action === "reload") {
        if (!this.hooks.reload)
          throw new Error("Runtime reload is not available in this process.");
        const result =
          (await this.hooks.reload(`agent.control.${context.origin}`)) || {};
        pendingRestart = result.pendingRestart === true;
        changed = true;
        evidence.push({
          id: "apply",
          kind: "probe",
          summary: pendingRestart
            ? "Runtime reloaded with a full restart still pending."
            : "Runtime reload completed.",
          ok: !result.error,
          data: sanitize(result) as Record<string, unknown>,
        });
        if (result.error) throw new Error(result.error);
      } else if (
        plan.capability !== "model_runtime" &&
        plan.capability !== "model_selection"
      ) {
        throw new Error("No mutation handler is available for this operation.");
      }

      const after = this.getState();
      evidence.push({
        id: "after",
        kind: "state",
        summary: "Resulting state read back after the operation.",
        ok: true,
        data: sanitize(after) as Record<string, unknown>,
      });
      const outcome: ControlOutcome = {
        operationId: plan.operationId,
        status: "succeeded",
        ok: true,
        changed,
        approvalRequired: false,
        pendingRestart,
        capability: plan.capability,
        action: plan.action,
        state: after,
        evidence,
        completedAt: completedAt(),
      };
      this.journal.append({
        operationId: plan.operationId,
        status: outcome.status,
        capability: plan.capability,
        action: plan.action,
        risk: plan.risk,
        input: plan.sanitizedInput,
        at: outcome.completedAt,
        changed,
        pending_restart: pendingRestart,
      });
      return outcome;
    } catch (error) {
      return this.failure(
        plan,
        error instanceof Error ? error.message : String(error),
        evidence,
      );
    }
  }

  private requiresApproval(
    risk: ControlRisk,
    context: ControlContext,
    capability: string,
    action: string,
  ): boolean {
    if (
      capability === "model_runtime" &&
      (action === "inspect" || action === "health")
    )
      return false;
    if (risk === "install" || risk === "service" || risk === "destructive")
      return true;
    return (
      risk === "config_write" &&
      context.origin !== "local" &&
      context.origin !== "dashboard"
    );
  }

  private findModelAdapter(
    input: Record<string, unknown> | undefined,
  ): ModelRuntimeAdapterLike | undefined {
    const provider = stringValue(input?.provider).toLowerCase();
    const adapterId = stringValue(input?.adapter).toLowerCase();
    if (adapterId || provider) {
      return this.modelAdapters.find(
        (item) =>
          item.id.toLowerCase() === adapterId ||
          item.provider.toLowerCase() === provider,
      );
    }
    return this.modelAdapters.length === 1 ? this.modelAdapters[0] : undefined;
  }

  private async isApproved(
    request: ControlOperationRequest,
    plan: ControlPlan,
  ): Promise<boolean> {
    if (!this.approvals.isApproved) return false;
    return Boolean(
      await this.approvals.isApproved(
        {
          operationId: plan.operationId,
          capability: plan.capability,
          action: plan.action,
          risk: plan.risk,
          reason: "Approval required for agent control operation.",
          sanitizedInput: plan.sanitizedInput,
          context: contextFrom(request),
          approvalRequestId: request.approvalRequestId,
        },
        request.approvalToken,
      ),
    );
  }

  private failure(
    plan: ControlPlan,
    error: string,
    evidence: ControlEvidence[] = [],
  ): ControlOutcome {
    const completedAt = new Date().toISOString();
    this.journal.append({
      operationId: plan.operationId,
      status: "failed",
      capability: plan.capability,
      action: plan.action,
      risk: plan.risk,
      input: plan.sanitizedInput,
      at: completedAt,
      error: sanitize(error),
    });
    return {
      operationId: plan.operationId,
      status: "failed",
      ok: false,
      changed: false,
      approvalRequired: plan.approvalRequired,
      pendingRestart: false,
      capability: plan.capability,
      action: plan.action,
      evidence: [
        ...plan.evidence,
        ...evidence,
        {
          id: "error",
          kind: "error",
          summary: String(sanitize(error)),
          ok: false,
        },
      ],
      error: String(sanitize(error)),
      completedAt,
    };
  }
}

export { DEFAULT_ALLOWED_CONFIG_PREFIXES };
