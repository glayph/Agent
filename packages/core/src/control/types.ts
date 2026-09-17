import type { RuntimePaths } from "../paths.js";

export type ControlRisk =
  "read" | "config_write" | "install" | "service" | "destructive";
export type ControlOrigin =
  "local" | "dashboard" | "telegram" | "mcp" | "api" | "system";
export type ControlOperationStatus =
  | "planned"
  | "approval_required"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ControlContext {
  origin: ControlOrigin;
  actor?: string;
  requestId?: string;
  sessionId?: string;
  workspaceDir?: string;
}

export interface ControlStep {
  id: string;
  title: string;
  capability: string;
  action: string;
  risk: ControlRisk;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  detail?: string;
}

export interface ControlEvidence {
  id: string;
  kind: "state" | "validation" | "probe" | "approval" | "journal" | "error";
  summary: string;
  ok: boolean;
  data?: Record<string, unknown>;
}

export interface ControlCapabilityDescriptor {
  id: string;
  label: string;
  description: string;
  risk: ControlRisk;
  platforms: Array<"linux" | "windows" | "darwin" | "all">;
  readOnly: boolean;
  actions: string[];
  supportsApproval: boolean;
  limitations: string[];
}

export interface ControlOperationRequest {
  capability: string;
  action: string;
  input?: Record<string, unknown>;
  context?: Partial<ControlContext>;
  approvalToken?: string;
  approvalRequestId?: string;
}

export interface ControlPlan {
  operationId: string;
  capability: string;
  action: string;
  risk: ControlRisk;
  status: ControlOperationStatus;
  idempotent: boolean;
  approvalRequired: boolean;
  sanitizedInput: Record<string, unknown>;
  steps: ControlStep[];
  evidence: ControlEvidence[];
  createdAt: string;
}

export interface ControlOutcome {
  operationId: string;
  status: ControlOperationStatus;
  ok: boolean;
  changed: boolean;
  approvalRequired: boolean;
  pendingRestart: boolean;
  capability: string;
  action: string;
  state?: Record<string, unknown>;
  evidence: ControlEvidence[];
  error?: string;
  completedAt: string;
}

export interface ControlApprovalRequest {
  operationId: string;
  capability: string;
  action: string;
  risk: ControlRisk;
  reason: string;
  sanitizedInput: Record<string, unknown>;
  context: ControlContext;
  approvalRequestId?: string;
}

export interface ControlApprovalAdapter {
  isApproved?(
    request: ControlApprovalRequest,
    token?: string,
  ): boolean | Promise<boolean>;
  requestApproval?(
    request: ControlApprovalRequest,
  ): Promise<{ requestId: string }>;
  consumeApproval?(
    request: ControlApprovalRequest,
    requestId: string,
  ): boolean | Promise<boolean>;
}

export interface ControlRuntimeHooks {
  reload?: (
    reason: string,
  ) => Promise<{ pendingRestart?: boolean; error?: string } | void>;
  readToolState?: () => Record<string, boolean>;
  readExtraState?: () => Record<string, unknown>;
}

export interface LauncherAdminControllerLike {
  getConfig(): Record<string, unknown>;
  validateConfig(candidate: Record<string, unknown>): Record<string, unknown>;
  validatePatch(patch: Record<string, unknown>): Record<string, unknown>;
  applyPatch(
    patch: Record<string, unknown>,
    reason?: string,
  ): Promise<Record<string, unknown>>;
  setToolState(
    name: string,
    enabled: boolean,
  ): Promise<Record<string, unknown>>;
  setActiveModel?(model: string): Promise<Record<string, unknown>>;
}

export interface ModelRuntimeAdapterLike {
  id: string;
  provider: string;
  inspect(
    model?: string,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  activate(model: string): Promise<Record<string, unknown>>;
  health(
    model?: string,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  install?: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  remove?: (model: string) => Promise<Record<string, unknown>>;
}

export interface AgentControlServiceOptions {
  controller: LauncherAdminControllerLike;
  runtimePaths: RuntimePaths;
  modelAdapters?: ModelRuntimeAdapterLike[];
  hooks?: ControlRuntimeHooks;
  approvals?: ControlApprovalAdapter;
  allowedConfigPrefixes?: string[];
}
