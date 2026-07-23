import * as fs from "fs";
import * as path from "path";
import {
  SkillInstaller,
  type InstalledSkill,
  type PluginContractKind,
} from "@hiro/installer";
import {
  SqliteAuditLog,
  type AuditEvent,
  type AuditEventType,
} from "../audit-log.js";
import {
  loadRuntimePluginContracts,
  type RuntimePluginContract,
  type RuntimePluginRiskLevel,
} from "./plugin-contract-runtime.js";

export type PluginMarketplaceReadinessStatus =
  | "ready"
  | "metadata_only"
  | "needs_policy"
  | "incomplete"
  | "blocked";

export type PluginMarketplaceIssueSeverity = "error" | "warning" | "info";

export interface PluginMarketplaceIssue {
  severity: PluginMarketplaceIssueSeverity;
  code: string;
  message: string;
  contract?: {
    kind: PluginContractKind;
    name: string;
  };
  path?: string;
  permission?: string;
}

export interface PluginMarketplaceContractSummary {
  total: number;
  executable: number;
  ready: number;
  metadataOnly: number;
  needsPolicy: number;
  blocked: number;
  byKind: Record<PluginContractKind, number>;
  permissions: string[];
  risk: RuntimePluginRiskLevel;
}

export interface PluginMarketplaceAuditEventSummary {
  type: Extract<AuditEventType, "plugin.execute" | "plugin.channel_runtime">;
  action?: string;
  status?: string;
  subject: string;
  createdAt: string;
  contractName?: string;
  kind?: string;
  error?: string;
}

export interface PluginMarketplaceAuditSummary {
  total: number;
  executions: number;
  channelRuntimeEvents: number;
  succeeded: number;
  failed: number;
  blocked: number;
  lastEventAt?: string;
  lastAction?: string;
  lastStatus?: string;
  recent: PluginMarketplaceAuditEventSummary[];
}

export interface PluginMarketplaceReadinessReport {
  plugin: {
    name: string;
    version: string;
    description: string;
    author?: string;
    license?: string;
    installedAt: string;
    sourceProtocol: InstalledSkill["sourceProtocol"];
    path: string;
    entrypoint: string;
    assetsPath?: string;
  };
  status: PluginMarketplaceReadinessStatus;
  marketplaceReady: boolean;
  score: number;
  summary: PluginMarketplaceContractSummary;
  audit: PluginMarketplaceAuditSummary;
  issues: PluginMarketplaceIssue[];
  contracts: RuntimePluginContract[];
}

export interface PluginMarketplaceReadinessResult {
  generatedAt: string;
  workspaceDir: string;
  skillsDir: string;
  configPath: string;
  total: number;
  summary: Record<PluginMarketplaceReadinessStatus, number> & {
    contracts: number;
    issues: number;
    auditEvents: number;
  };
  data: PluginMarketplaceReadinessReport[];
}

export interface BuildPluginMarketplaceReadinessOptions {
  skillsDir?: string;
  configPath?: string;
  auditPath?: string;
  includeAuditEvidence?: boolean;
  pluginName?: string;
  includeNonPluginSkills?: boolean;
}

const CONTRACT_KINDS: PluginContractKind[] = [
  "tools",
  "channels",
  "skills",
  "providers",
  "hooks",
];

const HARD_BLOCK_CODES = new Set([
  "contract_policy_blocked",
  "entrypoint_missing",
  "permission_blocked",
  "plugin_policy_blocked",
  "runtime_disabled",
  "undeclared_entrypoint_capability",
  "unsupported_runtime",
]);

const POLICY_REQUIRED_CODES = new Set([
  "execution_policy_required",
  "permission_policy_required",
]);

const INCOMPLETE_CODES = new Set([
  "missing_assets_path",
  "missing_author",
  "missing_contract_description",
  "missing_contracts",
  "missing_description",
  "missing_license",
]);

const EMPTY_AUDIT_SUMMARY: PluginMarketplaceAuditSummary = {
  total: 0,
  executions: 0,
  channelRuntimeEvents: 0,
  succeeded: 0,
  failed: 0,
  blocked: 0,
  recent: [],
};

const SUCCESS_ACTIONS = new Set(["succeeded", "message_replied", "started"]);
const FAILED_ACTIONS = new Set([
  "failed",
  "message_failed",
  "error",
  "process_closed",
]);
const BLOCKED_ACTIONS = new Set([
  "blocked",
  "rejected",
  "not_found",
  "skipped",
  "message_rejected",
]);

function emptyContractKindCounts(): Record<PluginContractKind, number> {
  return {
    tools: 0,
    channels: 0,
    skills: 0,
    providers: 0,
    hooks: 0,
  };
}

function emptyStatusCounts(): Record<PluginMarketplaceReadinessStatus, number> {
  return {
    ready: 0,
    metadata_only: 0,
    needs_policy: 0,
    incomplete: 0,
    blocked: 0,
  };
}

function emptyAuditSummary(): PluginMarketplaceAuditSummary {
  return {
    ...EMPTY_AUDIT_SUMMARY,
    recent: [],
  };
}

function detailString(
  details: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pluginNameForAuditEvent(event: AuditEvent): string | undefined {
  const explicit = detailString(event.details, "pluginName");
  if (explicit) return explicit;
  const subjectParts = event.subject.split(":");
  if (
    subjectParts.length >= 3 &&
    CONTRACT_KINDS.includes(subjectParts[1] as PluginContractKind)
  ) {
    return subjectParts[0] || undefined;
  }
  return undefined;
}

function auditEventSummary(
  event: AuditEvent,
): PluginMarketplaceAuditEventSummary | null {
  if (
    event.type !== "plugin.execute" &&
    event.type !== "plugin.channel_runtime"
  ) {
    return null;
  }
  return {
    type: event.type,
    action: detailString(event.details, "action"),
    status: detailString(event.details, "status"),
    subject: event.subject,
    createdAt: event.createdAt,
    contractName: detailString(event.details, "contractName"),
    kind: detailString(event.details, "kind"),
    error: detailString(event.details, "error"),
  };
}

function loadPluginAuditEvents(
  auditPath: string,
): Map<string, PluginMarketplaceAuditEventSummary[]> {
  const grouped = new Map<string, PluginMarketplaceAuditEventSummary[]>();
  if (!fs.existsSync(auditPath)) return grouped;

  const audit = new SqliteAuditLog(auditPath);
  try {
    const events = [
      ...audit.list({ type: "plugin.execute", limit: 500 }),
      ...audit.list({ type: "plugin.channel_runtime", limit: 500 }),
    ].sort((left, right) => {
      const leftTime = Date.parse(left.createdAt) || 0;
      const rightTime = Date.parse(right.createdAt) || 0;
      return rightTime - leftTime || right.id - left.id;
    });

    for (const event of events) {
      const pluginName = pluginNameForAuditEvent(event);
      const summary = auditEventSummary(event);
      if (!pluginName || !summary) continue;
      const current = grouped.get(pluginName) || [];
      current.push(summary);
      grouped.set(pluginName, current);
    }
  } finally {
    audit.close();
  }

  return grouped;
}

function summarizeAuditEvents(
  events: PluginMarketplaceAuditEventSummary[] = [],
): PluginMarketplaceAuditSummary {
  if (!events.length) return emptyAuditSummary();

  let executions = 0;
  let channelRuntimeEvents = 0;
  let succeeded = 0;
  let failed = 0;
  let blocked = 0;

  for (const event of events) {
    if (event.type === "plugin.execute") executions += 1;
    if (event.type === "plugin.channel_runtime") channelRuntimeEvents += 1;
    const action = event.action || "";
    if (SUCCESS_ACTIONS.has(action)) succeeded += 1;
    if (FAILED_ACTIONS.has(action)) failed += 1;
    if (BLOCKED_ACTIONS.has(action)) blocked += 1;
    if (event.status === "error") failed += 1;
    if (event.status === "policy_blocked") blocked += 1;
  }

  const [latest] = events;
  return {
    total: events.length,
    executions,
    channelRuntimeEvents,
    succeeded,
    failed,
    blocked,
    lastEventAt: latest?.createdAt,
    lastAction: latest?.action,
    lastStatus: latest?.status,
    recent: events.slice(0, 5),
  };
}

function hasPluginContracts(skill: InstalledSkill): boolean {
  return CONTRACT_KINDS.some(
    (kind) =>
      Boolean(skill.contracts?.[kind]?.length) ||
      Boolean(skill.plugin?.contracts?.[kind]?.length),
  );
}

function isMarketplaceCandidate(
  skill: InstalledSkill,
  options: BuildPluginMarketplaceReadinessOptions,
): boolean {
  if (options.pluginName) return skill.name === options.pluginName;
  if (options.includeNonPluginSkills) return true;
  return Boolean(skill.plugin) || hasPluginContracts(skill);
}

function issue(
  severity: PluginMarketplaceIssueSeverity,
  code: string,
  message: string,
  extra: Omit<PluginMarketplaceIssue, "severity" | "code" | "message"> = {},
): PluginMarketplaceIssue {
  return { severity, code, message, ...extra };
}

function missingMetadataIssues(
  skill: InstalledSkill,
): PluginMarketplaceIssue[] {
  const issues: PluginMarketplaceIssue[] = [];
  if (!skill.description?.trim()) {
    issues.push(
      issue(
        "warning",
        "missing_description",
        "Marketplace plugins should include a non-empty description.",
      ),
    );
  }
  if (!skill.author?.trim()) {
    issues.push(
      issue(
        "warning",
        "missing_author",
        "Marketplace plugins should declare an author.",
      ),
    );
  }
  if (!skill.license?.trim()) {
    issues.push(
      issue(
        "warning",
        "missing_license",
        "Marketplace plugins should declare a license.",
      ),
    );
  }
  if (!skill.assetsPath?.trim()) {
    issues.push(
      issue(
        "warning",
        "missing_assets_path",
        "Marketplace plugins should keep plugin files in a persisted assets path.",
      ),
    );
  } else if (!fs.existsSync(skill.assetsPath)) {
    issues.push(
      issue(
        "warning",
        "missing_assets_path",
        "The registered plugin assets path does not exist on disk.",
        { path: skill.assetsPath },
      ),
    );
  }
  return issues;
}

function contractMetadataIssues(
  contracts: RuntimePluginContract[],
): PluginMarketplaceIssue[] {
  const issues: PluginMarketplaceIssue[] = [];
  for (const contract of contracts) {
    if (!contract.contract.description?.trim()) {
      issues.push(
        issue(
          "warning",
          "missing_contract_description",
          "Marketplace contracts should include a user-facing description.",
          {
            contract: {
              kind: contract.kind,
              name: contract.contract.name,
            },
          },
        ),
      );
    }
  }
  return issues;
}

function readinessIssues(
  contract: RuntimePluginContract,
): PluginMarketplaceIssue[] {
  const issues: PluginMarketplaceIssue[] = [];
  const contractRef = {
    kind: contract.kind,
    name: contract.contract.name,
  };

  if (contract.readiness.risk.blockedPermissions.length) {
    for (const permission of contract.readiness.risk.blockedPermissions) {
      issues.push(
        issue(
          "error",
          "permission_blocked",
          `Permission "${permission}" is blocked by runtime policy.`,
          { contract: contractRef, permission },
        ),
      );
    }
  }

  if (contract.readiness.risk.requiresPolicy.length) {
    for (const permission of contract.readiness.risk.requiresPolicy) {
      issues.push(
        issue(
          "warning",
          "permission_policy_required",
          `Permission "${permission}" requires explicit runtime policy approval.`,
          { contract: contractRef, permission },
        ),
      );
    }
  }

  if (contract.readiness.risk.undeclaredPermissions.length) {
    for (const permission of contract.readiness.risk.undeclaredPermissions) {
      issues.push(
        issue(
          "error",
          "undeclared_entrypoint_capability",
          `Entrypoint appears to use "${permission}" but the contract does not declare that permission.`,
          { contract: contractRef, permission },
        ),
      );
    }
  }

  for (const reason of contract.readiness.reasons) {
    if (reason === "Plugin contract execution is disabled by policy.") {
      issues.push(
        issue(
          "warning",
          "execution_policy_required",
          "Executable plugin contracts require runtime.plugin_contracts.allow_execution=true.",
          { contract: contractRef },
        ),
      );
    } else if (reason === "Plugin contracts are disabled.") {
      issues.push(
        issue(
          "error",
          "runtime_disabled",
          "Plugin contracts are disabled by runtime policy.",
          { contract: contractRef },
        ),
      );
    } else if (reason.includes("is disabled by policy")) {
      issues.push(
        issue("error", "plugin_policy_blocked", reason, {
          contract: contractRef,
        }),
      );
    } else if (reason.includes("not allowed by policy")) {
      issues.push(
        issue("error", "contract_policy_blocked", reason, {
          contract: contractRef,
        }),
      );
    } else if (
      reason.includes("missing an entrypoint") ||
      reason.includes("Entrypoint resolves outside") ||
      reason.includes("Entrypoint file is missing")
    ) {
      issues.push(
        issue("error", "entrypoint_missing", reason, {
          contract: contractRef,
          path: contract.readiness.entrypointPath,
        }),
      );
    } else if (reason.includes("not supported by the plugin runner")) {
      issues.push(
        issue("error", "unsupported_runtime", reason, {
          contract: contractRef,
          path: contract.readiness.entrypointPath,
        }),
      );
    }
  }

  if (contract.readiness.risk.level === "high") {
    issues.push(
      issue(
        "info",
        "high_risk_permissions",
        "Contract requests high-risk permissions; verify policy and sandbox settings before publication.",
        { contract: contractRef },
      ),
    );
  }

  return dedupeIssues(issues);
}

function dedupeIssues(
  issues: PluginMarketplaceIssue[],
): PluginMarketplaceIssue[] {
  const seen = new Set<string>();
  const deduped: PluginMarketplaceIssue[] = [];
  for (const current of issues) {
    const key = [
      current.severity,
      current.code,
      current.message,
      current.contract?.kind,
      current.contract?.name,
      current.permission,
      current.path,
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(current);
  }
  return deduped;
}

function summarizeContracts(
  contracts: RuntimePluginContract[],
): PluginMarketplaceContractSummary {
  const byKind = emptyContractKindCounts();
  const permissions = new Set<string>();
  let executable = 0;
  let ready = 0;
  let metadataOnly = 0;
  let needsPolicy = 0;
  let blocked = 0;
  let risk: RuntimePluginRiskLevel = "low";

  for (const contract of contracts) {
    byKind[contract.kind] += 1;
    for (const permission of contract.permissions) {
      permissions.add(permission);
    }
    if (contract.readiness.executable) executable += 1;
    if (contract.readiness.status === "ready") ready += 1;
    if (contract.readiness.status === "metadata_only") metadataOnly += 1;
    if (contract.readiness.status === "requires_policy") needsPolicy += 1;
    if (contract.readiness.status === "policy_blocked") blocked += 1;
    if (contract.readiness.status === "needs_entrypoint") blocked += 1;
    if (contract.readiness.status === "unsupported_runtime") blocked += 1;
    if (contract.readiness.risk.level === "high") risk = "high";
    else if (contract.readiness.risk.level === "medium" && risk === "low") {
      risk = "medium";
    }
  }

  return {
    total: contracts.length,
    executable,
    ready,
    metadataOnly,
    needsPolicy,
    blocked,
    byKind,
    permissions: Array.from(permissions).sort(),
    risk,
  };
}

function hasIssueCode(
  issues: PluginMarketplaceIssue[],
  codes: Set<string>,
): boolean {
  return issues.some((current) => codes.has(current.code));
}

function classifyStatus(
  contracts: RuntimePluginContract[],
  issues: PluginMarketplaceIssue[],
): PluginMarketplaceReadinessStatus {
  if (hasIssueCode(issues, HARD_BLOCK_CODES)) return "blocked";
  if (hasIssueCode(issues, POLICY_REQUIRED_CODES)) return "needs_policy";
  if (hasIssueCode(issues, INCOMPLETE_CODES)) return "incomplete";
  if (
    contracts.length > 0 &&
    contracts.every((contract) => {
      return contract.readiness.status === "metadata_only";
    })
  ) {
    return "metadata_only";
  }
  return "ready";
}

function scoreReport(issues: PluginMarketplaceIssue[]): number {
  let score = 100;
  for (const current of issues) {
    if (current.severity === "error") score -= 30;
    else if (current.severity === "warning") score -= 10;
  }
  return Math.max(0, score);
}

function buildReport(
  skill: InstalledSkill,
  contracts: RuntimePluginContract[],
  audit: PluginMarketplaceAuditSummary = emptyAuditSummary(),
): PluginMarketplaceReadinessReport {
  const issues: PluginMarketplaceIssue[] = [
    ...missingMetadataIssues(skill),
    ...contractMetadataIssues(contracts),
  ];

  if (!contracts.length) {
    issues.push(
      issue(
        "warning",
        "missing_contracts",
        "Marketplace plugins should declare at least one capability contract.",
      ),
    );
  }

  for (const contract of contracts) {
    issues.push(...readinessIssues(contract));
  }

  const dedupedIssues = dedupeIssues(issues);
  const status = classifyStatus(contracts, dedupedIssues);

  return {
    plugin: {
      name: skill.name,
      version: skill.version,
      description: skill.description,
      author: skill.author,
      license: skill.license,
      installedAt: skill.installedAt,
      sourceProtocol: skill.sourceProtocol,
      path: skill.path,
      entrypoint: skill.entrypoint,
      assetsPath: skill.assetsPath,
    },
    status,
    marketplaceReady: status === "ready" || status === "metadata_only",
    score: scoreReport(dedupedIssues),
    summary: summarizeContracts(contracts),
    audit,
    issues: dedupedIssues,
    contracts,
  };
}

function groupContractsByPlugin(
  contracts: RuntimePluginContract[],
): Map<string, RuntimePluginContract[]> {
  const grouped = new Map<string, RuntimePluginContract[]>();
  for (const contract of contracts) {
    const current = grouped.get(contract.plugin.name) || [];
    current.push(contract);
    grouped.set(contract.plugin.name, current);
  }
  return grouped;
}

export async function buildPluginMarketplaceReadinessReport(
  workspaceDir: string,
  options: BuildPluginMarketplaceReadinessOptions = {},
): Promise<PluginMarketplaceReadinessResult> {
  const skillsDir =
    options.skillsDir || path.join(workspaceDir, "src", "skills");
  const configPath =
    options.configPath || path.join(workspaceDir, "config", "tools.yaml");
  const auditPath =
    options.auditPath || path.join(workspaceDir, "data", "audit.db");

  const installer = new SkillInstaller(skillsDir);
  await installer.init();
  const installed = await installer.getRegistry().listInstalled();
  const runtimeContracts = await loadRuntimePluginContracts(workspaceDir, {
    skillsDir,
    configPath,
  });
  const contractsByPlugin = groupContractsByPlugin(runtimeContracts);
  const auditByPlugin =
    options.includeAuditEvidence === false
      ? new Map<string, PluginMarketplaceAuditEventSummary[]>()
      : loadPluginAuditEvents(auditPath);

  const reports = installed
    .filter((skill) => isMarketplaceCandidate(skill, options))
    .map((skill) =>
      buildReport(
        skill,
        contractsByPlugin.get(skill.name) || [],
        summarizeAuditEvents(auditByPlugin.get(skill.name)),
      ),
    )
    .sort((left, right) => left.plugin.name.localeCompare(right.plugin.name));

  const statusCounts = emptyStatusCounts();
  let contractCount = 0;
  let issueCount = 0;
  let auditEventCount = 0;
  for (const report of reports) {
    statusCounts[report.status] += 1;
    contractCount += report.summary.total;
    issueCount += report.issues.length;
    auditEventCount += report.audit.total;
  }

  return {
    generatedAt: new Date().toISOString(),
    workspaceDir: path.resolve(workspaceDir),
    skillsDir: path.resolve(skillsDir),
    configPath: path.resolve(configPath),
    total: reports.length,
    summary: {
      ...statusCounts,
      contracts: contractCount,
      issues: issueCount,
      auditEvents: auditEventCount,
    },
    data: reports,
  };
}
