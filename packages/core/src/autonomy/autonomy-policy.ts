import fs from "node:fs";
import path from "node:path";
import type { EngineTool, ToolApprovalDecision, ToolApprovalPolicy } from "../engine/types.js";

export interface AutonomyPolicyConfig {
  safeWriteRoots?: string[];
  /** Kept for configuration compatibility. */
  maxWriteChars?: number;
  /** Kept for configuration compatibility. */
  maxMemoryChars?: number;
  allowBrowser?: boolean;
  browserAllowedDomains?: string[];
  allowComputerUse?: boolean;
  capabilityProfile?: "safe" | "developer" | "operator";
  /** Exact tool names available to this execution. */
  allowedTools?: string[];
  /** High-impact side-effect tools require explicit opt-in independent of profile. */
  allowedExternalSideEffectTools?: string[];
  workspaceRoot?: string;
}

function normalizeRelative(value: string): string {
  const replaced = value.replace(/\\/g, "/");
  if (path.posix.isAbsolute(replaced) || /^[A-Za-z]:\//.test(replaced)) return "__absolute__";
  return path.posix.normalize(replaced).replace(/^\.\//, "");
}

function insideRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root.replace(/\/$/, "")}/`);
}

const PATH_EFFECTS: Record<string, { keys: string[]; allMustBeAllowed: boolean }> = {
  file_write: { keys: ["path"], allMustBeAllowed: true },
  file_mkdir: { keys: ["path"], allMustBeAllowed: true },
  file_delete: { keys: ["path"], allMustBeAllowed: true },
  file_run: { keys: ["path"], allMustBeAllowed: true },
  file_rename: { keys: ["path"], allMustBeAllowed: true },
  file_move: { keys: ["path", "destination"], allMustBeAllowed: true },
  file_copy: { keys: ["path", "destination"], allMustBeAllowed: true },
};

const EXTERNAL_SIDE_EFFECT_TOOLS = new Set([
  "terminal_run", "terminal_kill", "delegate_coding_agent", "file_delete", "file_run", "skill_install", "skill_delete",
  "browser_click", "browser_type", "computer_invoke", "computer_set_text", "computer_hotkey",
  "computer_clipboard", "computer_launch", "computer_terminate_app", "computer_click_at",
  "computer_drag", "computer_scroll", "goal_create", "goal_update",
]);

/**
 * Enforces the resolved tool capability set at execution time. Tool-list omission is
 * retained for callers that use the policy outside autonomous goal execution; supervisor
 * callers always supply an exact allowlist.
 */
export class AutonomyPolicy implements ToolApprovalPolicy {
  private readonly safeWriteRoots: string[];
  private readonly capabilityProfile: "safe" | "developer" | "operator";
  private readonly allowedTools?: Set<string>;
  private readonly allowedExternalSideEffectTools: Set<string>;
  private readonly browserAllowedDomains: string[];
  private readonly allowBrowser: boolean;
  private readonly allowComputerUse: boolean;
  private readonly workspaceRoot?: string;
  private activeBrowserHostname?: string;

  constructor(config: AutonomyPolicyConfig = {}) {
    this.safeWriteRoots = (config.safeWriteRoots ?? ["autonomy", "identity/memory"])
      .map(normalizeRelative)
      .filter((root) => root && root !== "__absolute__" && root !== "." && root !== ".." && !root.startsWith("../"));
    this.capabilityProfile = config.capabilityProfile ?? "operator";
    this.allowedTools = Array.isArray(config.allowedTools) ? new Set(config.allowedTools) : undefined;
    this.allowedExternalSideEffectTools = new Set(config.allowedExternalSideEffectTools ?? []);
    this.browserAllowedDomains = (config.browserAllowedDomains ?? []).map((domain) => domain.toLowerCase().trim()).filter(Boolean);
    this.allowBrowser = config.allowBrowser === true;
    this.allowComputerUse = config.allowComputerUse === true;
    this.workspaceRoot = config.workspaceRoot ? path.resolve(config.workspaceRoot) : undefined;
  }

  describe(): { safeWriteRoots: string[]; capabilityProfile: string; allowedTools: string[]; allowedExternalSideEffectTools: string[] } {
    return {
      safeWriteRoots: [...this.safeWriteRoots],
      capabilityProfile: this.capabilityProfile,
      allowedTools: this.allowedTools ? [...this.allowedTools] : [],
      allowedExternalSideEffectTools: [...this.allowedExternalSideEffectTools],
    };
  }

  private pathAllowed(raw: unknown): boolean {
    if (typeof raw !== "string" || !raw.trim() || !this.safeWriteRoots.length) return false;
    // Backslashes are ambiguous on POSIX (literal filename) and separators on Windows.
    // Reject them rather than validate one spelling and execute another.
    if (raw.includes("\\")) return false;
    const normalizedRaw = raw.trim();
    const candidate = normalizeRelative(normalizedRaw);
    if (candidate === "__absolute__" || candidate === "." || candidate === ".." || candidate.startsWith("../")) return false;
    const allowedRoot = this.safeWriteRoots.find((root) => insideRoot(candidate, root));
    // A configured safe-write root is a directory boundary, not a valid file-operation target itself.
    if (!allowedRoot || candidate === allowedRoot) return false;
    if (this.workspaceRoot) {
      const absolute = path.resolve(this.workspaceRoot, candidate);
      const workspace = path.resolve(this.workspaceRoot);
      const relative = path.relative(workspace, absolute);
      if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) return false;
      const rootAbsolute = path.resolve(workspace, allowedRoot);
      const relativeRoot = path.relative(workspace, rootAbsolute);
      let realWorkspace: string;
      try { realWorkspace = fs.realpathSync(workspace); } catch { return false; }
      const expectedRealRoot = path.resolve(realWorkspace, relativeRoot);
      let realRoot = expectedRealRoot;
      if (fs.existsSync(rootAbsolute)) {
        try {
          realRoot = fs.realpathSync(rootAbsolute);
          // Configured safe roots (including their parent components) may not redirect through symlinks.
          if (realRoot !== expectedRealRoot) return false;
        } catch { return false; }
      }
      // Resolve an existing destination or its nearest existing parent. It must stay inside the
      // physical safe root, not merely somewhere else inside the workspace.
      let probe = absolute;
      while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
      try {
        const realProbe = fs.realpathSync(probe);
        const isWithin = (value: string, root: string) => value === root || value.startsWith(`${root}${path.sep}`);
        if (isWithin(probe, rootAbsolute)) {
          if (!isWithin(realProbe, realRoot)) return false;
        } else if (isWithin(rootAbsolute, probe)) {
          // The safe root does not exist yet, so the nearest existing parent may be above it.
          if (!isWithin(realRoot, realProbe)) return false;
        } else {
          return false;
        }
        if (fs.existsSync(absolute) && !isWithin(fs.realpathSync(absolute), realRoot)) return false;
      } catch { return false; }
    }
    return true;
  }

  decide(tool: EngineTool, input: Record<string, unknown>): ToolApprovalDecision {
    if (this.allowedTools && !this.allowedTools.has(tool.name)) {
      return { mode: "block", reason: `Tool "${tool.name}" is not in this goal's explicit capability allowlist.` };
    }
    if (tool.name.startsWith("browser_") && !this.allowBrowser) {
      return { mode: "block", reason: "Browser use is disabled by the autonomous capability policy." };
    }
    if (tool.name.startsWith("browser_")) {
      if (this.browserAllowedDomains.length === 0) {
        return { mode: "block", reason: "Browser actions require an explicit non-empty browser_allowed_domains allowlist." };
      }
      const rawUrl = typeof input.url === "string" ? input.url : typeof input.href === "string" ? input.href : undefined;
      const isNavigation = tool.name === "browser_navigate" || (tool.name === "browser_play_media" && Boolean(rawUrl));
      if (isNavigation) {
        if (!rawUrl) return { mode: "block", reason: "Browser navigation requires a valid URL." };
        try {
          const url = new URL(rawUrl);
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            return { mode: "block", reason: "Browser navigation only permits HTTP or HTTPS URLs." };
          }
          const hostname = url.hostname.toLowerCase();
          const allowed = this.browserAllowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
          if (!allowed) return { mode: "block", reason: `Browser domain is not allowlisted: ${hostname}.` };
          this.activeBrowserHostname = hostname;
        } catch {
          return { mode: "block", reason: "Browser action requires a valid HTTP or HTTPS URL." };
        }
      } else {
        // Most browser actions (click/type/extract/screenshot) do not include a URL in
        // their tool schema. Require an allowlisted navigation in this run first.
        // High-impact browser interactions still need explicit side-effect opt-in below.
        if (!this.activeBrowserHostname || !this.browserAllowedDomains.some((domain) => this.activeBrowserHostname === domain || this.activeBrowserHostname!.endsWith(`.${domain}`))) {
          return { mode: "block", reason: "Navigate to an allowlisted HTTP(S) domain before performing browser actions." };
        }
      }
    }
    if (tool.name.startsWith("computer_") && !this.allowComputerUse) {
      return { mode: "block", reason: "Computer use is disabled by the autonomous capability policy." };
    }
    if (EXTERNAL_SIDE_EFFECT_TOOLS.has(tool.name) && !this.allowedExternalSideEffectTools.has(tool.name)) {
      return { mode: "block", reason: `Tool "${tool.name}" can cause external side effects and requires explicit allowed_external_side_effect_tools opt-in.` };
    }
    const pathEffect = PATH_EFFECTS[tool.name];
    if (pathEffect) {
      const targets = pathEffect.keys.map((key) => input[key]);
      if (targets.some((target) => !this.pathAllowed(target))) {
        return { mode: "block", reason: `Path access for "${tool.name}" is outside configured safe_write_roots (${this.safeWriteRoots.join(", ") || "none"}).` };
      }
    }
    return { mode: "auto", reason: `Tool "${tool.name}" is allowed by the autonomous capability policy.` };
  }
}
