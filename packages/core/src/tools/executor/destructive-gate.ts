// BUG-08 FIX (deep re-audit): `config/agent.yaml`'s `tools.require_confirm_destructive`
// was defined in the shipped config and validated by the zod schema, but NO code
// anywhere read it. `ApprovalInbox` is fully wired for admin/config operations
// (admin-control-handlers.ts), skill installs (admin-skill-handlers.ts), and
// browser actions (isolated-browser-worker.ts) — but `handleShellExecute`,
// `handleFileWrite`, and `handleFileDelete` in handlers.ts never consulted
// `this.approvalInbox` at all. A model could always run `rm -rf <workspace>`,
// overwrite any file, or delete any file with zero human confirmation, even
// though the config already declared that destructive actions should require
// confirmation. This module classifies destructiveness and applies the same
// request/consume approval pattern already used elsewhere in the codebase.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { getCallContext } from "./call-context.js";
import type { ApprovalInbox } from "../../security/approval-inbox.js";

export type DestructiveApprovalGate = {
  requestId: string;
  context: { runId: string; stepId: string; deliveryId: string; previewHash: string };
};

export type GatedToolName =
  | "shell_execute"
  | "file_write"
  | "file_delete"
  | "computer_click_at"
  | "computer_invoke"
  | "computer_drag"
  | "computer_set_text"
  | "computer_hotkey"
  | "computer_launch"
  | "computer_terminate_app"
  | "computer_clipboard";

const COMPUTER_USE_TOOLS = new Set<GatedToolName>([
  "computer_click_at",
  "computer_invoke",
  "computer_drag",
  "computer_set_text",
  "computer_hotkey",
  "computer_launch",
  "computer_terminate_app",
  "computer_clipboard",
]);

interface AgentToolsConfig {
  require_confirm_destructive?: boolean;
  auto_approve_safe?: boolean;
  require_confirm_computer_use?: boolean;
}

let cachedConfigDir: string | undefined;
let cachedConfig: AgentToolsConfig | undefined;
let cachedMtimeMs = 0;

function loadAgentToolsConfig(configDir: string): AgentToolsConfig {
  const agentYamlPath = path.join(configDir, "agent.yaml");
  try {
    const stat = fs.statSync(agentYamlPath);
    if (
      cachedConfig &&
      cachedConfigDir === configDir &&
      cachedMtimeMs === stat.mtimeMs
    ) {
      return cachedConfig;
    }
    const doc = yaml.load(fs.readFileSync(agentYamlPath, "utf-8")) as
      | { tools?: AgentToolsConfig; agent?: { tools?: AgentToolsConfig } }
      | undefined;
    // AUDIT FIX: the shipped config/agent.yaml nests `tools:` under the
    // top-level `agent:` key (agent.ts reads it the same way, via
    // `asAgentConfig(this.config).agent?.model_routing` for the sibling
    // `model_routing` key) — but this loader was reading `doc.tools` at the
    // document root, which is always undefined against the real file. That
    // silently fell back to `{}`, which happened to still default
    // require_confirm_destructive to true (undefined !== false), so the gate
    // stayed on — but it meant `require_confirm_destructive: false` (or the
    // new require_confirm_computer_use) written into the real agent.yaml
    // could never actually take effect. Prefer the real nested location;
    // fall back to a flat `tools:` root for any other agent.yaml shape.
    cachedConfig = doc?.agent?.tools || doc?.tools || {};
    cachedConfigDir = configDir;
    cachedMtimeMs = stat.mtimeMs;
    return cachedConfig;
  } catch {
    // Fail safe: if agent.yaml cannot be read, default to requiring
    // confirmation rather than silently allowing destructive actions.
    return {
      require_confirm_destructive: true,
      auto_approve_safe: true,
      require_confirm_computer_use: true,
    };
  }
}

/** Whether destructive shell/file operations must be approved before running. */
export function requireConfirmDestructive(configDir: string): boolean {
  const cfg = loadAgentToolsConfig(configDir);
  return cfg.require_confirm_destructive !== false; // default true (matches shipped agent.yaml)
}

// COMPUTER-USE GATE (audit follow-up): computer_use ships with
// `level: TRUSTED_FULL_ACCESS` and mouse_input/allow_keyboard/allow_app_launch
// all true in config/tools.yaml, and none of the handleComputer* handlers in
// handlers.ts ever consulted ApprovalInbox — a model could move the mouse,
// type, press hotkeys, or launch/kill processes with zero human confirmation,
// unlike shell_execute/file_write/file_delete which are gated by
// requireConfirmDestructive() above. This mirrors that same pattern for the
// state-changing computer-use actions (click/invoke/drag/type/hotkey/launch/
// terminate/clipboard write). Read-only actions (observe, focus, screenshot,
// scroll, list_*, get_system_info, verify, clipboard read) are intentionally
// left ungated, matching how file_read is never gated.
export function requireConfirmComputerUse(configDir: string): boolean {
  const cfg = loadAgentToolsConfig(configDir);
  return cfg.require_confirm_computer_use !== false; // default true (fail safe)
}

// Heuristic classification of "destructive" shell commands: anything that can
// cause irreversible data loss, persistence/backdoor injection, or permission
// escalation. This is defense-in-depth alongside (not a replacement for) the
// hardcoded catastrophic blocklist in ShellExecutor.runShell(), which cannot
// be bypassed even with approval.
const DESTRUCTIVE_SHELL_PATTERNS: ReadonlyArray<RegExp> = [
  /\brm\s+-[a-zA-Z]*[rf]/i, // rm -rf, rm -fr, rm -f, rm -r (any target)
  /\bmv\s+.+\s+\//, // move into a root-level path
  /\bchmod\s+-R/i,
  /\bchown\s+-R/i,
  /\btruncate\s+/i,
  /\bshred\s+/i,
  /\bdd\s+if=/i,
  /\bmkfs/i,
  /\bwipefs/i,
  />>?\s*\/etc\//, // redirect into /etc (e.g. crontab injection)
  /\bcrontab\s+-[re]/i,
  /\bcrontab\s+-l\s*\|\s*\{/i,
  /\|\s*(sh|bash|zsh)\b/i, // pipe-to-shell (curl ... | sh)
  /\bgit\s+push\s+.*--force/i,
  /\bgit\s+reset\s+--hard/i,
  /\bkill\s+-9\b/i,
  /\bdocker\s+system\s+prune/i,
  /\bsystemctl\s+(stop|disable|mask)\b/i,
  /\bnpm\s+publish\b/i,
  /\byarn\s+publish\b/i,
];

export function isDestructiveShellCommand(command: string): boolean {
  return DESTRUCTIVE_SHELL_PATTERNS.some((re) => re.test(command));
}

function hashPreview(preview: string): string {
  return crypto.createHash("sha256").update(preview, "utf8").digest("hex");
}

/**
 * Gate a destructive shell/file/computer-use tool call behind ApprovalInbox,
 * mirroring the pattern already used in admin-control-handlers.ts. Returns:
 *  - null: not destructive (or confirmation disabled) — caller proceeds normally.
 *  - a JSON string: an approval_required response to hand back to the model/user.
 *  - throws: if approval_request_id was supplied but is invalid/expired/unapproved.
 * On success with a valid approval_request_id, the caller must call
 * consumeDestructiveApproval() after the action completes.
 */
export function destructiveApprovalGate(opts: {
  approvalInbox: ApprovalInbox | undefined;
  configDir: string;
  toolName: GatedToolName;
  resource: string;
  args: Record<string, unknown>;
}): { gate: DestructiveApprovalGate | null; response: string | null } {
  const isComputerUse = COMPUTER_USE_TOOLS.has(opts.toolName);
  const configFlag = isComputerUse
    ? "tools.require_confirm_computer_use"
    : "tools.require_confirm_destructive";
  const gateEnabled = isComputerUse
    ? requireConfirmComputerUse(opts.configDir)
    : requireConfirmDestructive(opts.configDir);

  if (!gateEnabled) {
    return { gate: null, response: null };
  }
  if (!opts.approvalInbox) {
    // Confirmation is required by config but no ApprovalInbox is wired up
    // (e.g. a minimal embedding of ToolRegistry). Fail closed with a clear
    // error rather than silently skipping the check.
    throw new Error(
      `${opts.toolName} requires owner approval (${configFlag} is enabled) ` +
        `but no approval service is configured. Refusing to run.`,
    );
  }

  const caller = getCallContext();
  const actor = caller?.actor || caller?.source || "local-agent";

  // Strip retry-only fields before hashing so the preview hash computed on
  // the original request matches the hash recomputed on the approved retry
  // (which now includes approval_request_id in args). Without this, retrying
  // with approval_request_id would always fail context-matching.
  const argsForPreview = { ...opts.args };
  delete argsForPreview.approval_request_id;
  delete argsForPreview.approval_token;
  const previewPayload = JSON.stringify({ tool: opts.toolName, args: argsForPreview });
  const previewHash = hashPreview(previewPayload);
  const approvalContext = {
    runId: `destructive:${previewHash.slice(0, 16)}`,
    stepId: `destructive-${opts.toolName}`,
    deliveryId: caller?.requestId || `${caller?.source || "local"}:${actor}`,
    previewHash,
  };

  const requestId =
    typeof opts.args.approval_request_id === "string"
      ? opts.args.approval_request_id.trim()
      : "";
  if (requestId) {
    opts.approvalInbox.assertApprovedByContext(requestId, approvalContext, actor);
    return { gate: { requestId, context: approvalContext }, response: null };
  }

  // "delete" for the original shell/file trio keeps their existing approval
  // wording/behavior unchanged; computer-use actions use "external_write"
  // (mouse/keyboard/process control reaching outside the sandboxed
  // workspace) — both are in ApprovalInbox's SIDE_EFFECT_ACTIONS set, so both
  // always require human approval.
  const challenge = opts.approvalInbox.request({
    runId: approvalContext.runId,
    actor,
    action: isComputerUse ? "external_write" : "delete",
    resource: opts.resource,
    risk: "high",
    reason: `${isComputerUse ? "Computer-use" : "Destructive"} ${opts.toolName} call requires confirmation (${configFlag}=true)`,
    context: approvalContext,
    ttlMs: 10 * 60 * 1000,
  });

  return {
    gate: null,
    response: JSON.stringify({
      approval_required: true,
      request_id: challenge.request.id,
      expires_at: challenge.request.expiresAt,
      tool: opts.toolName,
      preview: JSON.parse(previewPayload),
      instruction:
        `This action ${isComputerUse ? "controls the local computer (mouse/keyboard/process) and" : "is destructive and"} requires owner approval. ` +
        "Ask the owner to approve this request in the Web UI (Approvals) or via the Telegram " +
        "approval command, then retry the same tool call including approval_request_id. " +
        "Do not fabricate an approval_token.",
    }),
  };
}

export function consumeDestructiveApproval(
  approvalInbox: ApprovalInbox | undefined,
  gate: DestructiveApprovalGate,
): void {
  approvalInbox?.consumeByContext(
    gate.requestId,
    gate.context,
    getCallContext()?.actor || "local-agent",
  );
}
