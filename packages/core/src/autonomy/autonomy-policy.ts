import path from "node:path";
import type { EngineTool, ToolApprovalDecision, ToolApprovalPolicy } from "../engine/types.js";

export interface AutonomyPolicyConfig {
  safeWriteRoots?: string[];
  /** Maximum UTF-8 content length for autonomous new-file writes. */
  maxWriteChars?: number;
  /** Maximum UTF-8 content length for autonomous memory additions. */
  maxMemoryChars?: number;
  allowBrowser?: boolean;
  browserAllowedDomains?: string[];
  allowComputerUse?: boolean;
  /** Phase-2 capability profile. Higher profiles opt into progressively riskier local actions. */
  capabilityProfile?: "safe" | "developer" | "operator";
  /** Explicit tool grants for capabilities not covered by the built-in profile. */
  allowedTools?: string[];
  /** Explicitly permitted high-impact tools; never inferred from a generic risk label. */
  allowedExternalSideEffectTools?: string[];
}

const AUTO_READ_TOOLS = new Set([
  "file_read",
  "workspace_search",
  "memory_search",
  "web_search",
  "system_state",
  "logs",
  "goal_status",
]);

function normalizeRelative(value: string): string {
  const replaced = value.replace(/\\/g, "/");
  if (path.posix.isAbsolute(replaced) || /^[A-Za-z]:\//.test(replaced)) return "__absolute__";
  return path.posix.normalize(replaced).replace(/^\.\//, "");
}

function isWithinRoot(target: string, root: string): boolean {
  const normalizedTarget = normalizeRelative(target);
  const normalizedRoot = normalizeRelative(root).replace(/\/$/, "");
  if (!normalizedTarget || normalizedTarget === "__absolute__" || normalizedTarget === ".." || normalizedTarget.startsWith("../")) return false;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

/**
 * Phase-4 policy: read tools and memory writes are automatic. Workspace writes
 * are automatic only for new files under explicitly safe relative directories.
 * Everything else is blocked from an autonomous run rather than waiting for a
 * human approval that cannot be serviced by the heartbeat loop.
 */
export class AutonomyPolicy implements ToolApprovalPolicy {
  private readonly safeWriteRoots: string[];
  private readonly maxWriteChars: number;
  private readonly maxMemoryChars: number;
  private readonly allowBrowser: boolean;
  private readonly browserAllowedDomains: string[];
  private readonly allowComputerUse: boolean;
  private readonly capabilityProfile: "safe" | "developer" | "operator";
  private readonly allowedTools: Set<string>;
  private readonly allowedExternalSideEffectTools: Set<string>;

  constructor(config: AutonomyPolicyConfig = {}) {
    this.safeWriteRoots = (config.safeWriteRoots ?? ["autonomy", "identity/memory"])
      .map(normalizeRelative)
      .filter((root) => root && root !== "__absolute__" && root !== "." && root !== ".." && !root.startsWith("../"));
    this.maxWriteChars = Math.max(1, config.maxWriteChars ?? 256_000);
    this.maxMemoryChars = Math.max(1, config.maxMemoryChars ?? 4_000);
    this.allowBrowser = config.allowBrowser === true;
    this.browserAllowedDomains = (config.browserAllowedDomains ?? [])
      .map((domain) => domain.trim().toLowerCase().replace(/^\.+|\.+$/g, ""))
      .filter(Boolean);
    this.allowComputerUse = config.allowComputerUse === true;
    this.capabilityProfile = config.capabilityProfile ?? "safe";
    this.allowedTools = new Set(config.allowedTools ?? []);
    this.allowedExternalSideEffectTools = new Set(config.allowedExternalSideEffectTools ?? []);
  }

  describe(): { safeWriteRoots: string[]; capabilityProfile: string; allowedTools: string[]; allowedExternalSideEffectTools: string[] } {
    return {
      safeWriteRoots: [...this.safeWriteRoots],
      capabilityProfile: this.capabilityProfile,
      allowedTools: [...this.allowedTools],
      allowedExternalSideEffectTools: [...this.allowedExternalSideEffectTools],
    };
  }

  decide(tool: EngineTool, input: Record<string, unknown>): ToolApprovalDecision {
    if (this.allowedExternalSideEffectTools.has(tool.name)) {
      if (this.capabilityProfile !== "operator") {
        return { mode: "block", reason: `External side effect tool "${tool.name}" requires the operator capability profile.` };
      }
      return { mode: "auto", reason: "Explicitly granted external side-effect capability is enabled by operator policy." };
    }

    // High-impact local execution is never made safe merely by appearing in
    // a generic allowlist. It must first pass the capability-profile gate.
    if (tool.name === "shell_execute") {
      if (this.capabilityProfile === "safe") return { mode: "block", reason: "Shell execution is disabled in the safe autonomous profile." };
      if (!this.allowedTools.has(tool.name)) return { mode: "block", reason: "Shell execution requires an explicit autonomous tool grant." };
      return { mode: "auto", reason: `${this.capabilityProfile} autonomous profile permits policy-governed shell execution after explicit grant.` };
    }

    if (tool.name === "runtime_ensure") {
      if (this.capabilityProfile === "safe") return { mode: "block", reason: "Runtime installation is disabled in the safe autonomous profile." };
      if (!this.allowedTools.has(tool.name)) return { mode: "block", reason: "Runtime installation requires an explicit autonomous tool grant." };
      if (tool.risk === "install" && this.capabilityProfile !== "operator") return { mode: "block", reason: "Runtime installation requires the operator capability profile." };
      return { mode: "auto", reason: "Runtime installation is explicitly granted by the autonomous policy." };
    }

    if (this.allowedTools.has(tool.name)) {
      if (tool.risk === "destructive" && this.capabilityProfile !== "operator") {
        return { mode: "block", reason: `Destructive tool "${tool.name}" requires the operator capability profile.` };
      }
      if (tool.risk === "install" && this.capabilityProfile === "safe") {
        return { mode: "block", reason: `Install capability "${tool.name}" is disabled in the safe profile.` };
      }
      return { mode: "auto", reason: "Tool is explicitly granted by the autonomous capability policy." };
    }

    // Do not trust the risk label alone: a newly registered tool marked
    // "read" must not silently inherit autonomous access.
    if (tool.risk === "read" && AUTO_READ_TOOLS.has(tool.name) && tool.approval !== "required") {
      return { mode: "auto", reason: "Allowlisted read-only operation is permitted by autonomous policy." };
    }

    if (tool.name === "memory_add") {
      const content = typeof input.content === "string" ? input.content : "";
      if (content.trim() && content.length <= this.maxMemoryChars) {
        return { mode: "auto", reason: "Bounded durable-memory operation is allowed by autonomous policy." };
      }
      return { mode: "block", reason: `Autonomous memory additions must contain 1-${this.maxMemoryChars} characters.` };
    }

    if (tool.name === "browser_extract" || tool.name === "browser_screenshot") {
      if (!this.allowBrowser) return { mode: "block", reason: "Autonomous browser access is disabled by policy." };
      if (!this.browserAllowedDomains.length) return { mode: "block", reason: "Browser evidence requires an explicit autonomous domain allowlist." };
      return { mode: "auto", reason: "Read-only browser evidence is allowed for an explicitly allowlisted autonomous domain." };
    }

    if (tool.name === "browser_navigate" || tool.name === "browser_click" || tool.name === "browser_type") {
      if (!this.allowBrowser) return { mode: "block", reason: "Autonomous browser interaction is disabled by policy." };
      const rawUrl = typeof input.url === "string" ? input.url : "";
      if (tool.name !== "browser_navigate" && !this.browserAllowedDomains.length) {
        return { mode: "block", reason: "Browser interaction requires an explicit autonomous domain allowlist." };
      }
      if (tool.name === "browser_navigate") {
        try {
          const url = new URL(rawUrl);
          const hostname = url.hostname.toLowerCase();
          const allowed = this.browserAllowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
          if (!allowed) return { mode: "block", reason: `Browser domain '${hostname}' is not in the autonomous allowlist.` };
        } catch {
          return { mode: "block", reason: "Invalid browser URL." };
        }
      } else if (this.browserAllowedDomains.length === 0) {
        return { mode: "block", reason: "Browser interaction requires an explicit autonomous domain allowlist." };
      }
      return { mode: "auto", reason: "Browser action is permitted for an explicitly allowlisted autonomous domain." };
    }

    if (tool.name.startsWith("computer_")) {
      if (!this.allowComputerUse) return { mode: "block", reason: "Autonomous computer-use is disabled by policy." };
      const readOnly = new Set(["computer_observe", "computer_verify", "computer_screenshot", "computer_list_processes", "computer_get_system_info", "computer_list_displays"]);
      if (readOnly.has(tool.name)) return { mode: "auto", reason: "Computer observation is enabled by autonomous policy." };
      if (this.capabilityProfile !== "operator") return { mode: "block", reason: "State-changing computer actions require the operator autonomous profile." };
      if (!this.allowedTools.has(tool.name)) return { mode: "block", reason: `Computer action "${tool.name}" requires an explicit autonomous tool grant.` };
      return { mode: "auto", reason: "Explicitly granted operator computer interaction is enabled." };
    }

    if (tool.name === "file_mkdir") {
      const target = typeof input.path === "string" ? input.path : "";
      if (this.safeWriteRoots.some((root) => isWithinRoot(target, root))) {
        return { mode: "auto", reason: "Directory creation is confined to a safe autonomous workspace." };
      }
      return { mode: "block", reason: "Autonomous directory creation is restricted to configured safe write roots." };
    }

    if (tool.name === "file_write") {
      const target = typeof input.path === "string" ? input.path : "";
      const overwrite = input.overwrite === true;
      const content = typeof input.content === "string" ? input.content : "";
      if (!overwrite && content.length <= this.maxWriteChars && this.safeWriteRoots.some((root) => isWithinRoot(target, root))) {
        return { mode: "auto", reason: "Bounded new-file write is confined to a safe autonomous workspace." };
      }
      if (content.length > this.maxWriteChars) {
        return { mode: "block", reason: `Autonomous file writes are limited to ${this.maxWriteChars} characters.` };
      }
      if (overwrite) {
        return { mode: "block", reason: "Autonomous overwrite is disabled in autonomous mode; existing files remain protected." };
      }
      return { mode: "block", reason: "Autonomous file writes are restricted to configured safe write roots." };
    }

    return { mode: "block", reason: `Tool "${tool.name}" is not enabled by the autonomous policy.` };
  }
}
