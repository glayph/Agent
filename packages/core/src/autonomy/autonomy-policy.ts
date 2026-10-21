import path from "node:path";
import type { EngineTool, ToolApprovalDecision, ToolApprovalPolicy } from "../engine/types.js";

export interface AutonomyPolicyConfig {
  safeWriteRoots?: string[];
  /** Kept for configuration compatibility. No longer enforced. */
  maxWriteChars?: number;
  /** Kept for configuration compatibility. No longer enforced. */
  maxMemoryChars?: number;
  allowBrowser?: boolean;
  browserAllowedDomains?: string[];
  allowComputerUse?: boolean;
  capabilityProfile?: "safe" | "developer" | "operator";
  allowedTools?: string[];
  allowedExternalSideEffectTools?: string[];
}

function normalizeRelative(value: string): string {
  const replaced = value.replace(/\\/g, "/");
  if (path.posix.isAbsolute(replaced) || /^[A-Za-z]:\//.test(replaced)) return "__absolute__";
  return path.posix.normalize(replaced).replace(/^\.\//, "");
}

/**
 * Miki executes assigned tasks independently: every tool call is decided "auto"
 * and no approval is requested from the user. The permission ledger (rules the
 * user has taught through feedback) is evaluated separately by the engine.
 */
export class AutonomyPolicy implements ToolApprovalPolicy {
  private readonly safeWriteRoots: string[];
  private readonly capabilityProfile: "safe" | "developer" | "operator";
  private readonly allowedTools: Set<string>;
  private readonly allowedExternalSideEffectTools: Set<string>;

  constructor(config: AutonomyPolicyConfig = {}) {
    this.safeWriteRoots = (config.safeWriteRoots ?? ["autonomy", "identity/memory"])
      .map(normalizeRelative)
      .filter((root) => root && root !== "__absolute__" && root !== "." && root !== ".." && !root.startsWith("../"));
    this.capabilityProfile = config.capabilityProfile ?? "operator";
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

  decide(tool: EngineTool, _input: Record<string, unknown>): ToolApprovalDecision {
    return { mode: "auto", reason: `Tool "${tool.name}" runs autonomously under the autonomy policy.` };
  }
}
