import * as path from "path";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createWorkspaceSecretVault } from "@hiro/config";
import type { AgentOrchestrator } from "../agent.js";
import { SqliteAuditLog } from "../audit-log.js";
import {
  collectAgentResponse,
  splitOutboundMessage,
} from "../channels/agent-response.js";
import {
  listRuntimePluginChannelDescriptors,
  type RuntimePluginChannelDescriptor,
} from "./plugin-channel-adapter.js";
import { readPluginContractsPolicy } from "./plugin-contract-runtime.js";
import { type RuntimePaths } from "../paths.js";

type JsonRecord = Record<string, unknown>;
type PluginChannelRuntimeState = "running" | "stopped" | "skipped" | "error";

export interface PluginChannelRuntimeStatus {
  key: string;
  channelName: string;
  configKey: string;
  pluginName: string;
  contractName: string;
  status: PluginChannelRuntimeState;
  pid?: number;
  reason?: string;
  startedAt?: string;
}

interface ManagedPluginProcess {
  key: string;
  descriptor: RuntimePluginChannelDescriptor;
  child: ChildProcessWithoutNullStreams;
  startedAt: string;
  outputBytes: number;
}

interface PluginChannelRuntimeOptions {
  configPath?: string;
  maxReplyChars?: number;
  audit?: SqliteAuditLog | false;
  actor?: string;
}

const DEFAULT_MAX_REPLY_CHARS = 12_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const RUNTIME_EXTENSIONS: Record<string, "node" | "python"> = {
  ".cjs": "node",
  ".js": "node",
  ".mjs": "node",
  ".py": "python",
};

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolIsEnabled(value: unknown): boolean {
  return value === true;
}

function channelRuntimeKey(descriptor: RuntimePluginChannelDescriptor): string {
  return `${descriptor.pluginName}:${descriptor.contractName}`;
}

function matchesRuntimeName(
  descriptor: RuntimePluginChannelDescriptor,
  names: Set<string>,
): boolean {
  return (
    names.has(descriptor.metadata.name) ||
    names.has(descriptor.metadata.config_key) ||
    names.has(descriptor.contractName) ||
    names.has(`${descriptor.pluginName}:${descriptor.contractName}`)
  );
}

function runtimeCommand(entrypointPath: string): {
  command: string;
  args: string[];
} {
  const runtime =
    RUNTIME_EXTENSIONS[path.extname(entrypointPath).toLowerCase()];
  if (runtime === "node") return { command: process.execPath, args: [] };
  if (runtime === "python") return { command: "python", args: [] };
  throw new Error("Unsupported plugin channel runtime.");
}

function pluginEnvironment(paths: RuntimePaths | string): NodeJS.ProcessEnv {
  const workspaceDir =
    typeof paths === "string" ? paths : (paths.sourceDir ?? paths.configDir);
  const env: NodeJS.ProcessEnv = {
    Hiro_PLUGIN_SANDBOX: "1",
    Hiro_PLUGIN_CHANNEL_RUNTIME: "1",
    Hiro_WORKSPACE_DIR: workspaceDir,
    NODE_ENV: "production",
  };
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function channelSecretName(channelName: string, field: string): string {
  return `channels/${channelName}/${field}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function channelConfigWithSecrets(
  workspaceDir: string,
  descriptor: RuntimePluginChannelDescriptor,
  config: JsonRecord,
  includeSecrets: boolean,
): { config: JsonRecord; configuredSecrets: string[] } {
  const channels = recordOrEmpty(config.channels ?? config.channel_list);
  const raw = clone(recordOrEmpty(channels[descriptor.metadata.config_key]));
  const settings = recordOrEmpty(raw.settings);
  const configuredSecrets = new Set<string>();

  if (!includeSecrets) {
    return { config: raw, configuredSecrets: [] };
  }

  const vault = createWorkspaceSecretVault(workspaceDir);
  for (const field of descriptor.secretFields) {
    let value = settings[field] ?? raw[field];
    if (typeof value !== "string" || !value.trim()) {
      try {
        value =
          vault.get(channelSecretName(descriptor.metadata.config_key, field)) ||
          vault.get(channelSecretName(descriptor.metadata.name, field));
      } catch {
        value = "";
      }
    }
    if (typeof value === "string" && value.trim()) {
      settings[field] = value.trim();
      configuredSecrets.add(field);
    }
  }

  if (Object.keys(settings).length > 0) {
    raw.settings = settings;
  }
  return { config: raw, configuredSecrets: Array.from(configuredSecrets) };
}

function lineSessionId(
  descriptor: RuntimePluginChannelDescriptor,
  event: JsonRecord,
): string {
  const explicit = stringOrUndefined(event.sessionId);
  if (explicit) return explicit;
  const identity =
    stringOrUndefined(event.conversationId) ||
    stringOrUndefined(event.threadId) ||
    stringOrUndefined(event.userId) ||
    "default";
  const safeIdentity = identity.replace(/[^A-Za-z0-9_.:-]+/g, "_");
  return `plugin_${descriptor.metadata.name}_${safeIdentity}`;
}

function eventText(event: JsonRecord): string {
  return (
    stringOrUndefined(event.text) ||
    stringOrUndefined(event.message) ||
    stringOrUndefined(event.content) ||
    ""
  );
}

export class PluginChannelRuntimeManager {
  private readonly orchestrator: AgentOrchestrator;
  private readonly paths: RuntimePaths;
  private readonly configPath: string;
  private readonly maxReplyChars: number;
  private readonly audit?: SqliteAuditLog;
  private readonly auditPath?: string;
  private readonly actor: string;
  private readonly processes = new Map<string, ManagedPluginProcess>();
  private readonly statuses = new Map<string, PluginChannelRuntimeStatus>();

  constructor(
    orchestrator: AgentOrchestrator,
    paths: RuntimePaths,
    options: PluginChannelRuntimeOptions = {},
  ) {
    this.orchestrator = orchestrator;
    this.paths = paths;
    this.configPath =
      options.configPath || path.join(paths.configDir, "tools.yaml");
    this.maxReplyChars = options.maxReplyChars || DEFAULT_MAX_REPLY_CHARS;
    this.audit = options.audit || undefined;
    this.auditPath =
      options.audit === undefined
        ? path.join(paths.dataDir, "audit.db")
        : undefined;
    this.actor = options.actor || "plugin-runtime";
  }

  async startAll(): Promise<void> {
    await this.refresh();
  }

  async reload(names: string[]): Promise<void> {
    await this.refresh(new Set(names));
  }

  stopAll(): void {
    for (const key of Array.from(this.processes.keys())) {
      this.stopProcess(key, "shutdown");
    }
  }

  getStatuses(): PluginChannelRuntimeStatus[] {
    return Array.from(this.statuses.values()).map((status) => ({ ...status }));
  }

  private async refresh(names?: Set<string>): Promise<void> {
    const descriptors = await listRuntimePluginChannelDescriptors(
      this.paths.sourceDir ?? this.paths.configDir,
      { configPath: this.configPath },
    );
    const selected = names
      ? descriptors.filter((descriptor) =>
          matchesRuntimeName(descriptor, names),
        )
      : descriptors;
    const selectedKeys = new Set(selected.map(channelRuntimeKey));

    for (const key of Array.from(this.processes.keys())) {
      if (!names || selectedKeys.has(key)) {
        this.stopProcess(key, "reload");
      }
    }

    for (const descriptor of selected) {
      this.startDescriptor(descriptor);
    }
  }

  private startDescriptor(descriptor: RuntimePluginChannelDescriptor): void {
    const key = channelRuntimeKey(descriptor);
    const baseStatus = {
      key,
      channelName: descriptor.metadata.name,
      configKey: descriptor.metadata.config_key,
      pluginName: descriptor.pluginName,
      contractName: descriptor.contractName,
    };
    const policy = readPluginContractsPolicy(this.configPath);
    if (policy.allow_execution !== true) {
      this.setRuntimeStatus(
        descriptor,
        {
          ...baseStatus,
          status: "skipped",
          reason: "Plugin contract execution is disabled by policy.",
        },
        "skipped",
      );
      return;
    }
    if (policy.allow_channel_runtime !== true) {
      this.setRuntimeStatus(
        descriptor,
        {
          ...baseStatus,
          status: "skipped",
          reason:
            "Plugin channel runtime is disabled. Set runtime.plugin_contracts.allow_channel_runtime=true to enable it.",
        },
        "skipped",
      );
      return;
    }
    if (
      descriptor.contract.readiness.status !== "ready" ||
      !descriptor.contract.readiness.executable
    ) {
      this.setRuntimeStatus(
        descriptor,
        {
          ...baseStatus,
          status: "skipped",
          reason:
            descriptor.contract.readiness.reasons.join(" ") ||
            "Plugin channel contract is not executable.",
        },
        "skipped",
      );
      return;
    }

    const rawConfig = recordOrEmpty(
      recordOrEmpty(this.orchestrator.config.channels)[
        descriptor.metadata.config_key
      ],
    );
    if (!boolIsEnabled(rawConfig.enabled)) {
      this.setRuntimeStatus(
        descriptor,
        {
          ...baseStatus,
          status: "skipped",
          reason: "Plugin channel is disabled in channel configuration.",
        },
        "skipped",
      );
      return;
    }
    if (descriptor.secretFields.length > 0 && policy.allow_secrets !== true) {
      this.setRuntimeStatus(
        descriptor,
        {
          ...baseStatus,
          status: "skipped",
          reason:
            "Plugin channel secrets require runtime.plugin_contracts.allow_secrets=true.",
        },
        "skipped",
      );
      return;
    }

    const entrypointPath = descriptor.contract.readiness.entrypointPath;
    if (!entrypointPath) {
      this.setRuntimeStatus(
        descriptor,
        {
          ...baseStatus,
          status: "skipped",
          reason: "Plugin channel entrypoint is not resolved.",
        },
        "skipped",
      );
      return;
    }

    try {
      const command = runtimeCommand(entrypointPath);
      const child = spawn(command.command, [...command.args, entrypointPath], {
        cwd: path.dirname(entrypointPath),
        env: pluginEnvironment(this.paths),
        windowsHide: true,
      });
      const startedAt = new Date().toISOString();
      const processState: ManagedPluginProcess = {
        key,
        descriptor,
        child,
        startedAt,
        outputBytes: 0,
      };
      this.processes.set(key, processState);
      this.setRuntimeStatus(
        descriptor,
        {
          ...baseStatus,
          status: "running",
          pid: child.pid,
          startedAt,
        },
        "started",
      );
      this.attachProcessHandlers(processState);
      const workspaceDir = this.paths.sourceDir ?? this.paths.configDir;
      this.sendToProcess(processState, {
        type: "start",
        plugin: descriptor.contract.plugin,
        contract: descriptor.contract.contract,
        channel: descriptor.metadata,
        permissions: descriptor.contract.permissions,
        workspaceDir,
        ...channelConfigWithSecrets(
          workspaceDir,
          descriptor,
          this.orchestrator.config,
          policy.allow_secrets === true,
        ),
      });
    } catch (error) {
      this.setRuntimeStatus(
        descriptor,
        {
          ...baseStatus,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        },
        "error",
      );
    }
  }

  private setRuntimeStatus(
    descriptor: RuntimePluginChannelDescriptor,
    status: PluginChannelRuntimeStatus,
    action: "skipped" | "started" | "error" | "stopped" | "process_closed",
  ): void {
    this.statuses.set(status.key, status);
    this.recordRuntimeAudit(descriptor, action, status);
  }

  private recordRuntimeAudit(
    descriptor: RuntimePluginChannelDescriptor,
    action: string,
    status: PluginChannelRuntimeStatus,
    extra: JsonRecord = {},
  ): void {
    const audit =
      this.audit ||
      (this.auditPath ? new SqliteAuditLog(this.auditPath) : undefined);
    if (!audit) return;
    try {
      const risk = descriptor.contract.readiness.risk;
      audit.record({
        type: "plugin.channel_runtime",
        actor: this.actor,
        subject: `${descriptor.pluginName}:channels:${descriptor.contractName}`,
        details: {
          action,
          status: status.status,
          reason: status.reason,
          pid: status.pid,
          startedAt: status.startedAt,
          channelName: descriptor.metadata.name,
          configKey: descriptor.metadata.config_key,
          pluginName: descriptor.pluginName,
          contractName: descriptor.contractName,
          permissions: [...descriptor.contract.permissions],
          risk: {
            level: risk.level,
            permissions: [...risk.permissions],
            requiresPolicy: [...risk.requiresPolicy],
            blockedPermissions: [...risk.blockedPermissions],
          },
          ...extra,
        },
      });
    } catch {
      // Audit logging must not affect channel runtime behavior.
    } finally {
      if (!this.audit) {
        try {
          audit.close();
        } catch {
          // Ignore audit close failures.
        }
      }
    }
  }

  private currentStatusFor(
    processState: ManagedPluginProcess,
  ): PluginChannelRuntimeStatus {
    return (
      this.statuses.get(processState.key) || {
        key: processState.key,
        channelName: processState.descriptor.metadata.name,
        configKey: processState.descriptor.metadata.config_key,
        pluginName: processState.descriptor.pluginName,
        contractName: processState.descriptor.contractName,
        status: "running",
      }
    );
  }

  private attachProcessHandlers(processState: ManagedPluginProcess): void {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const maxOutputBytes =
      readPluginContractsPolicy(this.configPath).max_output_bytes ||
      DEFAULT_MAX_OUTPUT_BYTES;

    processState.child.stdin.on("error", () => {
      // The plugin may exit while the runtime is sending stop/reply messages.
    });

    processState.child.stdout.on("data", (chunk: Buffer) => {
      processState.outputBytes += chunk.byteLength;
      if (processState.outputBytes > maxOutputBytes) {
        this.stopProcess(
          processState.key,
          `max output exceeded ${maxOutputBytes} bytes`,
        );
        return;
      }
      stdoutBuffer += chunk.toString("utf-8");
      const lines = stdoutBuffer.split(/
?
/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        this.handlePluginLine(processState, line).catch((error) => {
          console.warn(
            `Plugin channel ${processState.key} message handling failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    });

    processState.child.stderr.on("data", (chunk: Buffer) => {
      // Count stderr toward the shared output budget to prevent unbounded growth
      processState.outputBytes += chunk.byteLength;
      if (processState.outputBytes > maxOutputBytes) {
        console.warn(
          `Plugin channel ${processState.key}: stderr exceeded max_output_bytes (${maxOutputBytes}), terminating`
        );
        processState.child.kill("SIGTERM");
        return;
      }
      stderrBuffer += chunk.toString("utf-8");
      // Cap partial stderrBuffer to prevent unbounded memory on lines without newline
      if (stderrBuffer.length > 8192) {
        stderrBuffer = stderrBuffer.slice(-4096);
      }
      const lines = stderrBuffer.split(/\n?\n/);
      stderrBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          console.warn(`Plugin channel ${processState.key}: ${line.trim()}`);
        }
      }
    });

    processState.child.on("error", (error) => {
      this.processes.delete(processState.key);
      this.setRuntimeStatus(
        processState.descriptor,
        {
          key: processState.key,
          channelName: processState.descriptor.metadata.name,
          configKey: processState.descriptor.metadata.config_key,
          pluginName: processState.descriptor.pluginName,
          contractName: processState.descriptor.contractName,
          status: "error",
          reason: error.message,
        },
        "error",
      );
    });

    processState.child.on("close", (code) => {
      this.processes.delete(processState.key);
      const previous = this.statuses.get(processState.key);
      if (previous?.status === "error" || previous?.status === "skipped") {
        return;
      }
      this.setRuntimeStatus(
        processState.descriptor,
        {
          key: processState.key,
          channelName: processState.descriptor.metadata.name,
          configKey: processState.descriptor.metadata.config_key,
          pluginName: processState.descriptor.pluginName,
          contractName: processState.descriptor.contractName,
          status: code === 0 ? "stopped" : "error",
          reason:
            code === 0
              ? "Plugin channel process stopped."
              : `Plugin channel process exited with code ${code}.`,
        },
        "process_closed",
      );
    });
  }

  private async handlePluginLine(
    processState: ManagedPluginProcess,
    line: string,
  ): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: JsonRecord;
    try {
      event = JSON.parse(trimmed) as JsonRecord;
    } catch {
      console.log(`Plugin channel ${processState.key}: ${trimmed}`);
      return;
    }

    const type = stringOrUndefined(event.type);
    if (type === "ready") {
      return;
    }
    if (type === "log") {
      console.log(
        `Plugin channel ${processState.key}: ${
          stringOrUndefined(event.message) || ""
        }`,
      );
      return;
    }
    if (type !== "message" && type !== "inbound_message") {
      console.warn(`Plugin channel ${processState.key}: unknown event ${type}`);
      return;
    }

    const text = eventText(event);
    if (!text) {
      this.recordRuntimeAudit(
        processState.descriptor,
        "message_rejected",
        this.currentStatusFor(processState),
        {
          eventType: type,
          hasId: event.id !== undefined,
          reason: "missing_text",
        },
      );
      this.sendToProcess(processState, {
        type: "error",
        id: event.id,
        error: "Inbound plugin channel message is missing text.",
      });
      return;
    }

    const sessionId = lineSessionId(processState.descriptor, event);
    const currentStatus = this.currentStatusFor(processState);
    this.recordRuntimeAudit(
      processState.descriptor,
      "message_received",
      currentStatus,
      {
        eventType: type,
        hasId: event.id !== undefined,
        sessionId,
      },
    );
    try {
      const reply = await collectAgentResponse(
        this.orchestrator,
        sessionId,
        text,
        this.maxReplyChars,
      );
      this.sendToProcess(processState, {
        type: "reply",
        id: event.id,
        sessionId,
        text: reply,
        parts: splitOutboundMessage(reply, this.maxReplyChars),
      });
      this.recordRuntimeAudit(
        processState.descriptor,
        "message_replied",
        currentStatus,
        {
          eventType: type,
          hasId: event.id !== undefined,
          sessionId,
        },
      );
    } catch (error) {
      this.recordRuntimeAudit(
        processState.descriptor,
        "message_failed",
        currentStatus,
        {
          eventType: type,
          hasId: event.id !== undefined,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      this.sendToProcess(processState, {
        type: "error",
        id: event.id,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private sendToProcess(
    processState: ManagedPluginProcess,
    payload: JsonRecord,
  ): void {
    if (
      processState.child.stdin.destroyed ||
      !processState.child.stdin.writable
    ) {
      return;
    }
    processState.child.stdin.write(`${JSON.stringify(payload)}
`);
  }

  private stopProcess(key: string, reason: string): void {
    const processState = this.processes.get(key);
    if (!processState) return;
    this.processes.delete(key);
    try {
      this.sendToProcess(processState, { type: "stop", reason });
      processState.child.kill();
    } catch {
      // Ignore shutdown failures.
    }
    this.setRuntimeStatus(
      processState.descriptor,
      {
        key,
        channelName: processState.descriptor.metadata.name,
        configKey: processState.descriptor.metadata.config_key,
        pluginName: processState.descriptor.pluginName,
        contractName: processState.descriptor.contractName,
        status: "stopped",
        reason,
      },
      "stopped",
    );
  }
}
