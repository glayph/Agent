import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { spawn } from "child_process";
import { SqliteAuditLog } from "../audit-log.js";
import {
  SkillInstaller,
  type PluginContractCatalogEntry,
  type PluginContractKind,
} from "@hiro/installer";
import { normalizeRuntimePaths, type RuntimePaths } from "../paths.js";

export type RuntimePluginContractStatus =
  | "ready"
  | "metadata_only"
  | "needs_entrypoint"
  | "unsupported_runtime"
  | "requires_policy"
  | "policy_blocked";

export type RuntimePluginRiskLevel = "low" | "medium" | "high";

export interface RuntimePluginContractReadiness {
  status: RuntimePluginContractStatus;
  executable: boolean;
  reasons: string[];
  entrypointPath?: string;
  staticAnalysis: {
    scanned: boolean;
    detectedPermissions: string[];
    undeclaredPermissions: string[];
    warnings: string[];
  };
  risk: {
    level: RuntimePluginRiskLevel;
    permissions: string[];
    requiresPolicy: string[];
    blockedPermissions: string[];
    undeclaredPermissions: string[];
  };
  sandbox: {
    filesystem: "none" | "read" | "write";
    network: boolean;
    secrets: boolean;
    shell: boolean;
  };
}

export interface RuntimePluginContract {
  plugin: PluginContractCatalogEntry["plugin"];
  kind: PluginContractKind;
  contract: PluginContractCatalogEntry["contract"];
  permissions: string[];
  readiness: RuntimePluginContractReadiness;
}

export interface RuntimePluginContractsConfig {
  enabled?: boolean;
  allow_execution?: boolean;
  allow_channel_runtime?: boolean;
  allowed_kinds?: PluginContractKind[];
  disabled_plugins?: string[];
  disabled_contracts?: string[];
  allowed_permissions?: string[];
  blocked_permissions?: string[];
  allowed_runtimes?: RuntimePluginEntrypointRuntime[];
  execution_timeout_ms?: number;
  max_output_bytes?: number;
  allow_network?: boolean;
  allow_secrets?: boolean;
  allow_filesystem_write?: boolean;
  allow_shell?: boolean;
  require_entrypoint_for?: PluginContractKind[];
}

interface LoadRuntimePluginContractsOptions {
  skillsDir?: string;
  configPath?: string;
  kind?: PluginContractKind;
}

type RuntimePluginEntrypointRuntime = "node" | "python";

export interface RuntimePluginToolExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  status?: RuntimePluginContractStatus;
  executionTimeMs: number;
  plugin?: RuntimePluginContract["plugin"];
  contract?: RuntimePluginContract["contract"];
}

export type RuntimePluginContractExecutionResult =
  RuntimePluginToolExecutionResult;

interface ExecuteRuntimePluginContractOptions {
  skillsDir?: string;
  configPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  audit?: SqliteAuditLog | false;
  actor?: string;
  requestId?: string;
  runId?: string;
}

interface ExecuteRuntimePluginToolOptions extends ExecuteRuntimePluginContractOptions {}

interface PluginExecutionAuditTarget {
  audit?: SqliteAuditLog;
  closeAfterRecord: boolean;
}

const DEFAULT_ENTRYPOINT_KINDS = new Set<PluginContractKind>([
  "tools",
  "hooks",
]);
const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_ALLOWED_RUNTIMES: RuntimePluginEntrypointRuntime[] = ["node"];
const MAX_ENTRYPOINT_SCAN_BYTES = 256 * 1024;
const SUPPORTED_RUNTIME_EXTENSIONS: Record<
  string,
  RuntimePluginEntrypointRuntime
> = {
  ".cjs": "node",
  ".js": "node",
  ".mjs": "node",
  ".py": "python",
};

const ENTRYPOINT_CAPABILITY_RULES: Array<{
  permission: string;
  pattern: RegExp;
}> = [
  { permission: "network.http", pattern: /\bfetch\s*\(/ },
  {
    permission: "network.http",
    pattern: /\brequire\s*\(\s*["']https?["']\s*\)/,
  },
  { permission: "network.http", pattern: /\bfrom\s+["']https?["']/ },
  { permission: "network.http", pattern: /\bimport\s+["']https?["']/ },
  { permission: "network.http", pattern: /\baxios\b/ },
  { permission: "network.http", pattern: /\brequests\./ },
  { permission: "network.http", pattern: /\burllib\b/ },
  {
    permission: "network.socket",
    pattern: /\brequire\s*\(\s*["']net["']\s*\)/,
  },
  { permission: "network.socket", pattern: /\bsocket\./ },
  { permission: "secrets.env", pattern: /\bprocess\.env\b/ },
  { permission: "secrets.env", pattern: /\bDeno\.env\b/ },
  { permission: "secrets.env", pattern: /\bos\.environ\b/ },
  { permission: "secrets.env", pattern: /\bdotenv\b/ },
  {
    permission: "shell.execute",
    pattern: /\brequire\s*\(\s*["']child_process["']\s*\)/,
  },
  { permission: "shell.execute", pattern: /\bchild_process\b/ },
  {
    permission: "shell.execute",
    pattern: /\b(exec|execFile|spawn|spawnSync)\s*\(/,
  },
  { permission: "shell.execute", pattern: /\bsubprocess\./ },
  { permission: "shell.execute", pattern: /\bos\.system\s*\(/ },
  {
    permission: "fs.write",
    pattern:
      /\b(writeFile|appendFile|createWriteStream|unlink|rm|rmdir|mkdir)\w*\s*\(/,
  },
  {
    permission: "fs.write",
    pattern: /\bfs\.promises\.(writeFile|appendFile|rm|unlink|mkdir|rmdir)\b/,
  },
  { permission: "fs.write", pattern: /\bopen\s*\([^,\n]+,\s*["'][wax]\b/ },
  { permission: "fs.write", pattern: /\bshutil\.(rmtree|copy|move)\s*\(/ },
  {
    permission: "fs.write",
    pattern: /\bos\.(remove|unlink|mkdir|rmdir|replace)\s*\(/,
  },
];

function pluginExecutionAudit(
  workspaceDir: string,
  options: ExecuteRuntimePluginContractOptions,
): PluginExecutionAuditTarget {
  if (options.audit === false) return { closeAfterRecord: false };
  if (options.audit) return { audit: options.audit, closeAfterRecord: false };
  return {
    audit: new SqliteAuditLog(path.join(workspaceDir, "data", "audit.db")),
    closeAfterRecord: true,
  };
}

function payloadKeys(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).sort();
}

function recordPluginExecutionAudit(
  target: PluginExecutionAuditTarget,
  options: ExecuteRuntimePluginContractOptions,
  details: {
    action: "blocked" | "not_found" | "rejected" | "succeeded" | "failed";
    workspaceDir: string;
    kind: PluginContractKind;
    requestedName: string;
    payload: Record<string, unknown>;
    executionTimeMs: number;
    contract?: RuntimePluginContract;
    status?: RuntimePluginContractStatus;
    error?: string;
  },
): void {
  if (!target.audit) return;
  const contract = details.contract;
  try {
    const risk = contract?.readiness.risk;
    const sandbox = contract?.readiness.sandbox;
    target.audit.record({
      type: "plugin.execute",
      actor: options.actor || "plugin-runtime",
      subject: contract
        ? `${contract.plugin.name}:${details.kind}:${contract.contract.name}`
        : `${details.kind}:${details.requestedName}`,
      requestId: options.requestId,
      runId: options.runId,
      details: {
        action: details.action,
        kind: details.kind,
        requestedName: details.requestedName,
        pluginName: contract?.plugin.name,
        contractName: contract?.contract.name,
        status: details.status || contract?.readiness.status,
        executable: contract?.readiness.executable,
        reasons: contract?.readiness.reasons || [],
        risk: risk
          ? {
              level: risk.level,
              permissions: [...risk.permissions],
              requiresPolicy: [...risk.requiresPolicy],
              blockedPermissions: [...risk.blockedPermissions],
              undeclaredPermissions: [...risk.undeclaredPermissions],
            }
          : undefined,
        staticAnalysis: contract?.readiness.staticAnalysis
          ? {
              scanned: contract.readiness.staticAnalysis.scanned,
              detectedPermissions: [
                ...contract.readiness.staticAnalysis.detectedPermissions,
              ],
              undeclaredPermissions: [
                ...contract.readiness.staticAnalysis.undeclaredPermissions,
              ],
              warnings: [...contract.readiness.staticAnalysis.warnings],
            }
          : undefined,
        sandbox: sandbox
          ? {
              filesystem: sandbox.filesystem,
              network: sandbox.network,
              usesSecrets: sandbox.secrets,
              shell: sandbox.shell,
            }
          : undefined,
        permissions: contract ? [...contract.permissions] : [],
        payloadKeys: payloadKeys(details.payload),
        executionTimeMs: details.executionTimeMs,
        error: details.error,
      },
    });
  } catch {
    // Audit logging must never change plugin execution behavior.
  } finally {
    if (target.closeAfterRecord) {
      try {
        target.audit.close();
      } catch {
        // Ignore audit close failures.
      }
    }
  }
}

export function readPluginContractsPolicy(
  configPath: string,
): RuntimePluginContractsConfig {
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = (yaml.load(fs.readFileSync(configPath, "utf-8")) || {}) as {
      plugin_contracts?: RuntimePluginContractsConfig;
      runtime?: { plugin_contracts?: RuntimePluginContractsConfig };
    };
    return parsed.runtime?.plugin_contracts || parsed.plugin_contracts || {};
  } catch {
    return {};
  }
}

function matchesRule(value: string, rule: string): boolean {
  if (rule.endsWith("*")) return value.startsWith(rule.slice(0, -1));
  return value === rule;
}

function permissionIsAllowed(
  permission: string,
  policy: RuntimePluginContractsConfig,
): boolean {
  return (policy.allowed_permissions || []).some((rule) =>
    matchesRule(permission, rule),
  );
}

function permissionIsBlocked(
  permission: string,
  policy: RuntimePluginContractsConfig,
): boolean {
  return (policy.blocked_permissions || []).some((rule) =>
    matchesRule(permission, rule),
  );
}

function classifyPermission(permission: string) {
  if (permission.startsWith("network.")) return "network";
  if (permission.startsWith("secrets.")) return "secrets";
  if (
    permission.startsWith("fs.write") ||
    permission.startsWith("fs.delete") ||
    permission.startsWith("file.write") ||
    permission.startsWith("file.delete")
  ) {
    return "filesystem_write";
  }
  if (
    permission.startsWith("fs.") ||
    permission.startsWith("file.") ||
    permission === "filesystem"
  ) {
    return "filesystem_read";
  }
  if (permission.startsWith("shell.") || permission === "shell") {
    return "shell";
  }
  return "other";
}

function permissionIsDeclared(
  permission: string,
  declaredPermissions: string[],
): boolean {
  return declaredPermissions.some((declared) => {
    if (matchesRule(permission, declared)) return true;
    const declaredClass = classifyPermission(declared);
    const permissionClass = classifyPermission(permission);
    return (
      declaredClass !== "other" &&
      permissionClass !== "other" &&
      declaredClass === permissionClass
    );
  });
}

function scanEntrypointCapabilities(entrypointPath?: string): {
  scanned: boolean;
  detectedPermissions: string[];
  undeclaredPermissions: string[];
  warnings: string[];
} {
  if (!entrypointPath) {
    return {
      scanned: false,
      detectedPermissions: [],
      undeclaredPermissions: [],
      warnings: [],
    };
  }

  const warnings: string[] = [];
  let source: string;
  try {
    const stat = fs.statSync(entrypointPath);
    if (stat.size > MAX_ENTRYPOINT_SCAN_BYTES) {
      warnings.push(
        `Entrypoint static scan was limited to ${MAX_ENTRYPOINT_SCAN_BYTES} bytes.`,
      );
    }
    const buffer = fs.readFileSync(entrypointPath);
    source = buffer.subarray(0, MAX_ENTRYPOINT_SCAN_BYTES).toString("utf-8");
  } catch {
    return {
      scanned: false,
      detectedPermissions: [],
      undeclaredPermissions: [],
      warnings: ["Entrypoint static scan could not read the file."],
    };
  }

  const detected = new Set<string>();
  for (const rule of ENTRYPOINT_CAPABILITY_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(source)) {
      detected.add(rule.permission);
    }
  }

  return {
    scanned: true,
    detectedPermissions: Array.from(detected).sort(),
    undeclaredPermissions: [],
    warnings,
  };
}

function resolveEntrypoint(entry: PluginContractCatalogEntry): {
  path?: string;
  runtime?: RuntimePluginEntrypointRuntime;
  reason?: string;
} {
  const entrypoint = entry.contract.entrypoint;
  if (!entrypoint) return {};
  const baseDir = entry.plugin.assetsPath || path.dirname(entry.plugin.path);
  const resolved = path.resolve(baseDir, entrypoint);
  const relative = path.relative(baseDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      reason: "Entrypoint resolves outside the installed plugin assets.",
    };
  }
  if (!fs.existsSync(resolved)) {
    return {
      reason: "Entrypoint file is missing from installed plugin assets.",
    };
  }
  const runtime =
    SUPPORTED_RUNTIME_EXTENSIONS[path.extname(resolved).toLowerCase()];
  if (!runtime) {
    return {
      path: resolved,
      reason: "Entrypoint runtime is not supported by the plugin runner.",
    };
  }
  return { path: resolved, runtime };
}

function evaluateContract(
  entry: PluginContractCatalogEntry,
  policy: RuntimePluginContractsConfig,
): RuntimePluginContractReadiness {
  const reasons: string[] = [];
  const blockedPermissions = entry.permissions.filter((permission) =>
    permissionIsBlocked(permission, policy),
  );
  const requiresPolicy: string[] = [];
  const sandbox = {
    filesystem: "none" as "none" | "read" | "write",
    network: false,
    secrets: false,
    shell: false,
  };

  for (const permission of entry.permissions) {
    const classification = classifyPermission(permission);
    if (classification === "network") {
      sandbox.network = true;
      if (!policy.allow_network && !permissionIsAllowed(permission, policy)) {
        requiresPolicy.push(permission);
      }
    } else if (classification === "secrets") {
      sandbox.secrets = true;
      if (!policy.allow_secrets && !permissionIsAllowed(permission, policy)) {
        requiresPolicy.push(permission);
      }
    } else if (classification === "filesystem_write") {
      sandbox.filesystem = "write";
      if (
        !policy.allow_filesystem_write &&
        !permissionIsAllowed(permission, policy)
      ) {
        requiresPolicy.push(permission);
      }
    } else if (classification === "filesystem_read") {
      if (sandbox.filesystem === "none") sandbox.filesystem = "read";
    } else if (classification === "shell") {
      sandbox.shell = true;
      if (!policy.allow_shell && !permissionIsAllowed(permission, policy)) {
        requiresPolicy.push(permission);
      }
    }
  }

  const requireEntrypointKinds = new Set(
    policy.require_entrypoint_for || Array.from(DEFAULT_ENTRYPOINT_KINDS),
  );
  const allowedRuntimes = policy.allowed_runtimes || DEFAULT_ALLOWED_RUNTIMES;
  const entrypoint = resolveEntrypoint(entry);
  const requiresEntrypoint = requireEntrypointKinds.has(entry.kind);
  const staticAnalysis = scanEntrypointCapabilities(entrypoint.path);
  const undeclaredPermissions = staticAnalysis.detectedPermissions.filter(
    (permission) => !permissionIsDeclared(permission, entry.permissions),
  );
  staticAnalysis.undeclaredPermissions = undeclaredPermissions;

  if (policy.enabled === false) reasons.push("Plugin contracts are disabled.");
  if (
    policy.allowed_kinds?.length &&
    !policy.allowed_kinds.includes(entry.kind)
  ) {
    reasons.push(`Contract kind "${entry.kind}" is not allowed by policy.`);
  }
  if (policy.disabled_plugins?.includes(entry.plugin.name)) {
    reasons.push(`Plugin "${entry.plugin.name}" is disabled by policy.`);
  }
  if (
    policy.disabled_contracts?.includes(entry.contract.name) ||
    policy.disabled_contracts?.includes(
      `${entry.kind}:${entry.contract.name}`,
    ) ||
    policy.disabled_contracts?.includes(
      `${entry.plugin.name}:${entry.kind}:${entry.contract.name}`,
    )
  ) {
    reasons.push(`Contract "${entry.contract.name}" is disabled by policy.`);
  }
  if (blockedPermissions.length) {
    reasons.push("One or more permissions are blocked by policy.");
  }
  if (requiresEntrypoint && !entry.contract.entrypoint) {
    reasons.push("Executable contract is missing an entrypoint.");
  }
  if (entry.contract.entrypoint && entrypoint.reason) {
    reasons.push(entrypoint.reason);
  }
  if (entrypoint.runtime && !allowedRuntimes.includes(entrypoint.runtime)) {
    reasons.push(`Runtime "${entrypoint.runtime}" is not allowed by policy.`);
  }
  if (
    entry.contract.entrypoint &&
    entrypoint.path &&
    policy.allow_execution !== true
  ) {
    reasons.push("Plugin contract execution is disabled by policy.");
  }
  if (requiresPolicy.length) {
    reasons.push("Contract requires explicit plugin permission policy.");
  }
  for (const permission of undeclaredPermissions) {
    reasons.push(
      `Entrypoint appears to use "${permission}" but the contract does not declare that permission.`,
    );
  }

  const riskLevel: RuntimePluginRiskLevel =
    sandbox.shell ||
    sandbox.secrets ||
    sandbox.filesystem === "write" ||
    blockedPermissions.length > 0 ||
    undeclaredPermissions.length > 0
      ? "high"
      : sandbox.network || sandbox.filesystem === "read"
        ? "medium"
        : "low";

  let status: RuntimePluginContractStatus = "ready";
  if (
    policy.enabled === false ||
    blockedPermissions.length > 0 ||
    policy.disabled_plugins?.includes(entry.plugin.name) ||
    policy.disabled_contracts?.includes(entry.contract.name) ||
    policy.disabled_contracts?.includes(
      `${entry.kind}:${entry.contract.name}`,
    ) ||
    policy.disabled_contracts?.includes(
      `${entry.plugin.name}:${entry.kind}:${entry.contract.name}`,
    ) ||
    (entrypoint.runtime && !allowedRuntimes.includes(entrypoint.runtime)) ||
    (entry.contract.entrypoint &&
      Boolean(entrypoint.path) &&
      policy.allow_execution !== true) ||
    (policy.allowed_kinds?.length && !policy.allowed_kinds.includes(entry.kind))
  ) {
    status = "policy_blocked";
  } else if (
    (requiresEntrypoint && !entry.contract.entrypoint) ||
    Boolean(
      entry.contract.entrypoint &&
      entrypoint.reason !==
        "Entrypoint runtime is not supported by the plugin runner." &&
      entrypoint.reason,
    )
  ) {
    status = "needs_entrypoint";
  } else if (
    entry.contract.entrypoint &&
    entrypoint.reason ===
      "Entrypoint runtime is not supported by the plugin runner."
  ) {
    status = "unsupported_runtime";
  } else if (requiresPolicy.length) {
    status = "requires_policy";
  } else if (undeclaredPermissions.length) {
    status = "requires_policy";
  } else if (!entry.contract.entrypoint) {
    status = "metadata_only";
  }

  return {
    status,
    executable: status === "ready" && Boolean(entrypoint.path),
    reasons,
    entrypointPath: entrypoint.path,
    staticAnalysis,
    risk: {
      level: riskLevel,
      permissions: entry.permissions,
      requiresPolicy,
      blockedPermissions,
      undeclaredPermissions,
    },
    sandbox,
  };
}

export async function loadRuntimePluginContracts(
  paths: RuntimePaths | string,
  options: LoadRuntimePluginContractsOptions = {},
): Promise<RuntimePluginContract[]> {
  const runtimePaths = normalizeRuntimePaths(paths);
  const skillsDir = options.skillsDir || runtimePaths.skillsDir;
  const configPath =
    options.configPath || path.join(runtimePaths.configDir, "tools.yaml");
  const policy = readPluginContractsPolicy(configPath);
  const installer = new SkillInstaller(skillsDir);
  await installer.init();
  const entries = await installer
    .getRegistry()
    .listPluginContracts(options.kind);

  return entries.map((entry) => ({
    plugin: entry.plugin,
    kind: entry.kind,
    contract: entry.contract,
    permissions: entry.permissions,
    readiness: evaluateContract(entry, policy),
  }));
}

function runtimeCommand(runtime: RuntimePluginEntrypointRuntime): {
  command: string;
  args: string[];
} {
  if (runtime === "node") return { command: process.execPath, args: [] };
  return { command: "python", args: [] };
}

function buildPluginEnvironment(
  paths: RuntimePaths,
  sandbox: {
    filesystem: "none" | "read" | "write";
    network: boolean;
    secrets: boolean;
    shell: boolean;
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    Hiro_PLUGIN_SANDBOX: "1",
    Hiro_WORKSPACE_DIR: paths.sourceDir || paths.configDir,
    Hiro_SANDBOX_FILESYSTEM: sandbox.filesystem,
    Hiro_SANDBOX_NETWORK: sandbox.network.toString(),
    Hiro_SANDBOX_SECRETS: sandbox.secrets.toString(),
    Hiro_SANDBOX_SHELL: sandbox.shell.toString(),
    NODE_ENV: "production",
  };

  // Limit environment variables for better isolation
  const allowedEnvVars = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
  ];

  for (const key of allowedEnvVars) {
    if (process.env[key]) env[key] = process.env[key];
  }

  return env;
}

function normalizePluginOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (typeof record.output === "string") return record.output;
      if (typeof record.result === "string") return record.result;
    }
  } catch {
    // Plain text output is valid.
  }
  return stdout;
}

async function runPluginProcess(options: {
  runtime: RuntimePluginEntrypointRuntime;
  entrypointPath: string;
  payload: unknown;
  runtimePaths: RuntimePaths;
  timeoutMs: number;
  maxOutputBytes: number;
  sandbox: {
    filesystem: "none" | "read" | "write";
    network: boolean;
    secrets: boolean;
    shell: boolean;
  };
}): Promise<string> {
  const command = runtimeCommand(options.runtime);
  const payload = JSON.stringify(options.payload);

  return await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(
      command.command,
      [...command.args, options.entrypointPath],
      {
        cwd: path.dirname(options.entrypointPath),
        env: buildPluginEnvironment(options.runtimePaths, options.sandbox),
        windowsHide: true,
      },
    );

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Plugin tool timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    const appendOutput = (kind: "stdout" | "stderr", chunk: Buffer) => {
      if (settled) return;
      if (kind === "stdout") stdout += chunk.toString("utf-8");
      else stderr += chunk.toString("utf-8");
      if (
        Buffer.byteLength(stdout, "utf-8") +
          Buffer.byteLength(stderr, "utf-8") >
        options.maxOutputBytes
      ) {
        settled = true;
        clearTimeout(timeout);
        child.kill();
        reject(
          new Error(
            `Plugin tool exceeded max output of ${options.maxOutputBytes} bytes`,
          ),
        );
      }
    };

    child.stdout.on("data", (chunk: Buffer) => appendOutput("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => appendOutput("stderr", chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            `Plugin tool exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }
      resolve(normalizePluginOutput(stdout));
    });

    child.stdin.end(payload);
  });
}

export async function executeRuntimePluginContract(
  workspaceDir: RuntimePaths | string,
  kind: PluginContractKind,
  contractName: string,
  payload: Record<string, unknown> = {},
  options: ExecuteRuntimePluginContractOptions = {},
): Promise<RuntimePluginContractExecutionResult> {
  const startMs = Date.now();
  const runtimePaths = normalizeRuntimePaths(workspaceDir);
  const workspaceRoot = runtimePaths.sourceDir ?? runtimePaths.configDir;
  const configPath =
    options.configPath || path.join(runtimePaths.configDir, "tools.yaml");
  const policy = readPluginContractsPolicy(configPath);
  const audit = pluginExecutionAudit(workspaceRoot, options);

  if (policy.allow_execution !== true) {
    recordPluginExecutionAudit(audit, options, {
      action: "blocked",
      workspaceDir: workspaceRoot,
      kind,
      requestedName: contractName,
      payload,
      executionTimeMs: Date.now() - startMs,
      status: "policy_blocked",
      error:
        "Plugin contract execution is disabled. Set runtime.plugin_contracts.allow_execution=true to enable it.",
    });
    return {
      success: false,
      output: "",
      error:
        "Plugin contract execution is disabled. Set runtime.plugin_contracts.allow_execution=true to enable it.",
      status: "policy_blocked",
      executionTimeMs: Date.now() - startMs,
    };
  }

  const contracts = await loadRuntimePluginContracts(workspaceDir, {
    skillsDir: options.skillsDir,
    configPath,
    kind,
  });
  const contract = contracts.find(
    (entry) =>
      entry.contract.name === contractName ||
      `${entry.plugin.name}:${entry.contract.name}` === contractName,
  );

  if (!contract) {
    recordPluginExecutionAudit(audit, options, {
      action: "not_found",
      workspaceDir: workspaceRoot,
      kind,
      requestedName: contractName,
      payload,
      executionTimeMs: Date.now() - startMs,
      error: `Plugin ${kind} contract "${contractName}" was not found.`,
    });
    return {
      success: false,
      output: "",
      error: `Plugin ${kind} contract "${contractName}" was not found.`,
      executionTimeMs: Date.now() - startMs,
    };
  }

  if (contract.readiness.status !== "ready" || !contract.readiness.executable) {
    const error =
      contract.readiness.reasons.join(" ") ||
      `Plugin ${kind} contract "${contractName}" is not executable.`;
    recordPluginExecutionAudit(audit, options, {
      action: "rejected",
      workspaceDir: workspaceRoot,
      kind,
      requestedName: contractName,
      payload,
      executionTimeMs: Date.now() - startMs,
      contract,
      status: contract.readiness.status,
      error,
    });
    return {
      success: false,
      output: "",
      error,
      status: contract.readiness.status,
      executionTimeMs: Date.now() - startMs,
      plugin: contract.plugin,
      contract: contract.contract,
    };
  }

  const entrypointPath = contract.readiness.entrypointPath;
  if (!entrypointPath) {
    recordPluginExecutionAudit(audit, options, {
      action: "rejected",
      workspaceDir: workspaceRoot,
      kind,
      requestedName: contractName,
      payload,
      executionTimeMs: Date.now() - startMs,
      contract,
      status: "needs_entrypoint",
      error: `Plugin ${kind} contract "${contractName}" has no resolved entrypoint.`,
    });
    return {
      success: false,
      output: "",
      error: `Plugin ${kind} contract "${contractName}" has no resolved entrypoint.`,
      status: "needs_entrypoint",
      executionTimeMs: Date.now() - startMs,
      plugin: contract.plugin,
      contract: contract.contract,
    };
  }

  const runtime =
    SUPPORTED_RUNTIME_EXTENSIONS[path.extname(entrypointPath).toLowerCase()];
  if (!runtime) {
    recordPluginExecutionAudit(audit, options, {
      action: "rejected",
      workspaceDir: workspaceRoot,
      kind,
      requestedName: contractName,
      payload,
      executionTimeMs: Date.now() - startMs,
      contract,
      status: "unsupported_runtime",
      error: `Plugin ${kind} contract "${contractName}" uses an unsupported runtime.`,
    });
    return {
      success: false,
      output: "",
      error: `Plugin ${kind} contract "${contractName}" uses an unsupported runtime.`,
      status: "unsupported_runtime",
      executionTimeMs: Date.now() - startMs,
      plugin: contract.plugin,
      contract: contract.contract,
    };
  }

  try {
    const output = await runPluginProcess({
      runtime,
      entrypointPath,
      runtimePaths,
      payload: {
        ...payload,
        plugin: contract.plugin,
        kind,
        contract: contract.contract,
        permissions: contract.permissions,
        workspaceDir,
        runtime: {
          // Policy-only sandbox metadata — not process-enforced.
          // The plugin runs in a child process with limited env but no OS-level sandbox.
          policy_sandbox: true,
          enforced_sandbox: false,
          workspaceDir,
          filesystem: contract.readiness.sandbox.filesystem,
          network: contract.readiness.sandbox.network,
          secrets: contract.readiness.sandbox.secrets,
          shell: contract.readiness.sandbox.shell,
        },
      },
      timeoutMs:
        options.timeoutMs ||
        policy.execution_timeout_ms ||
        DEFAULT_EXECUTION_TIMEOUT_MS,
      maxOutputBytes:
        options.maxOutputBytes ||
        policy.max_output_bytes ||
        DEFAULT_MAX_OUTPUT_BYTES,
      sandbox: contract.readiness.sandbox,
    });
    recordPluginExecutionAudit(audit, options, {
      action: "succeeded",
      workspaceDir: workspaceRoot,
      kind,
      requestedName: contractName,
      payload,
      executionTimeMs: Date.now() - startMs,
      contract,
      status: contract.readiness.status,
    });
    return {
      success: true,
      output,
      status: contract.readiness.status,
      executionTimeMs: Date.now() - startMs,
      plugin: contract.plugin,
      contract: contract.contract,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    recordPluginExecutionAudit(audit, options, {
      action: "failed",
      workspaceDir: workspaceRoot,
      kind,
      requestedName: contractName,
      payload,
      executionTimeMs: Date.now() - startMs,
      contract,
      status: contract.readiness.status,
      error: errorMessage,
    });
    return {
      success: false,
      output: "",
      error: errorMessage,
      status: contract.readiness.status,
      executionTimeMs: Date.now() - startMs,
      plugin: contract.plugin,
      contract: contract.contract,
    };
  }
}

export async function executeRuntimePluginTool(
  workspaceDir: string,
  toolName: string,
  args: Record<string, unknown>,
  options: ExecuteRuntimePluginToolOptions = {},
): Promise<RuntimePluginToolExecutionResult> {
  return executeRuntimePluginContract(
    workspaceDir,
    "tools",
    toolName,
    { args },
    options,
  );
}
