import fs from "node:fs/promises";
import path from "node:path";
import { validateNetworkUrl } from "./network-security.js";

export type GoalAcceptanceCheck =
  | { type: "final_text_contains"; text: string; caseSensitive?: boolean }
  | { type: "final_text_regex"; pattern: string; flags?: string }
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; text: string; caseSensitive?: boolean }
  | { type: "http_status"; url: string; expectedStatus?: number; bodyContains?: string; timeoutMs?: number }
  | { type: "tool_called"; name: string; status?: string };

export interface GoalAcceptanceContract {
  mode?: "all" | "any";
  checks: GoalAcceptanceCheck[];
}

export interface GoalAcceptanceToolEvidence {
  name: string;
  status?: string;
}

export interface GoalAcceptanceContext {
  finalText: string;
  toolCalls?: GoalAcceptanceToolEvidence[];
  workspaceRoot?: string;
}

export interface GoalAcceptanceResult {
  passed: boolean;
  reason: string;
  checks: Array<{ type: string; passed: boolean; detail: string }>;
}

const DEFAULT_ACCEPTANCE_BUDGET_MS = 15_000;
const ACCEPTANCE_CHECK_TYPES = new Set([
  "final_text_contains", "final_text_regex", "file_exists", "file_contains", "http_status", "tool_called",
]);

/** Validate persisted/user-provided contracts before an autonomous run can have side effects. */
export function isGoalAcceptanceContract(value: unknown): value is GoalAcceptanceContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { mode?: unknown; checks?: unknown };
  if (candidate.mode !== undefined && candidate.mode !== "all" && candidate.mode !== "any") return false;
  if (!Array.isArray(candidate.checks) || candidate.checks.length === 0 || candidate.checks.length > 25) return false;
  // Final model text is not independent proof that the requested work occurred.
  // Require at least one artifact, HTTP response, or successfully observed tool call.
  const hasIndependentEvidence = candidate.checks.some((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const type = (raw as Record<string, unknown>).type;
    return type === "file_exists" || type === "file_contains" || type === "http_status" || type === "tool_called";
  });
  if (!hasIndependentEvidence) return false;
  return candidate.checks.every((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const check = raw as Record<string, unknown>;
    if (typeof check.type !== "string" || !ACCEPTANCE_CHECK_TYPES.has(check.type)) return false;
    switch (check.type) {
      case "final_text_contains":
        return typeof check.text === "string" && check.text.trim().length > 0;
      case "final_text_regex":
        if (typeof check.pattern !== "string" || !check.pattern) return false;
        try { new RegExp(check.pattern, typeof check.flags === "string" ? check.flags : undefined); return true; } catch { return false; }
      case "file_exists":
        return typeof check.path === "string" && check.path.trim().length > 0;
      case "file_contains":
        return typeof check.path === "string" && check.path.trim().length > 0 && typeof check.text === "string" && check.text.length > 0;
      case "http_status":
        return typeof check.url === "string" && /^https?:\/\//i.test(check.url) && (check.expectedStatus === undefined || (Number.isInteger(check.expectedStatus) && Number(check.expectedStatus) >= 100 && Number(check.expectedStatus) <= 599));
      case "tool_called":
        return typeof check.name === "string" && check.name.trim().length > 0 && check.status === "succeeded";
      default:
        return false;
    }
  });
}

function safeRelative(root: string, requested: string): string {
  const normalizedRoot = path.resolve(root);
  const candidate = path.resolve(normalizedRoot, requested);
  const relative = path.relative(normalizedRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Acceptance file path escapes the workspace root");
  return candidate;
}

function matchesText(actual: string, expected: string, caseSensitive = false): boolean {
  return caseSensitive ? actual.includes(expected) : actual.toLowerCase().includes(expected.toLowerCase());
}

export async function verifyGoalAcceptance(
  contract: GoalAcceptanceContract | null | undefined,
  context: GoalAcceptanceContext,
  maxDurationMs = DEFAULT_ACCEPTANCE_BUDGET_MS,
): Promise<GoalAcceptanceResult> {
  if (!contract || !isGoalAcceptanceContract(contract)) {
    return { passed: false, reason: "No deterministic Goal Acceptance Contract with valid independent evidence is configured.", checks: [] };
  }
  const checks: GoalAcceptanceResult["checks"] = [];
  const deadline = Date.now() + Math.max(0, Math.min(120_000, Math.floor(maxDurationMs)));
  for (const check of contract.checks) {
    if (Date.now() >= deadline) {
      checks.push({ type: "budget_exhausted", passed: false, detail: "Acceptance verification exceeded its total time budget." });
      break;
    }
    try {
      if (check.type === "final_text_contains") {
        const passed = matchesText(context.finalText, check.text, check.caseSensitive);
        checks.push({ type: check.type, passed, detail: passed ? `Final output contains '${check.text}'.` : `Final output does not contain '${check.text}'.` });
      } else if (check.type === "final_text_regex") {
        const regex = new RegExp(check.pattern, check.flags);
        const passed = regex.test(context.finalText);
        checks.push({ type: check.type, passed, detail: passed ? `Final output matches /${check.pattern}/.` : `Final output does not match /${check.pattern}/.` });
      } else if (check.type === "file_exists") {
        if (!context.workspaceRoot) throw new Error("workspaceRoot is required for file checks");
        const target = safeRelative(context.workspaceRoot, check.path);
        const stat = await fs.stat(target).catch(() => null);
        const passed = Boolean(stat);
        checks.push({ type: check.type, passed, detail: passed ? `File exists: ${check.path}` : `File does not exist: ${check.path}` });
      } else if (check.type === "file_contains") {
        if (!context.workspaceRoot) throw new Error("workspaceRoot is required for file checks");
        const target = safeRelative(context.workspaceRoot, check.path);
        const content = await fs.readFile(target, "utf8");
        const passed = matchesText(content, check.text, check.caseSensitive);
        checks.push({ type: check.type, passed, detail: passed ? `File ${check.path} contains the expected text.` : `File ${check.path} does not contain the expected text.` });
      } else if (check.type === "tool_called") {
        const calls = context.toolCalls ?? [];
        const passed = calls.some((call) => call.name === check.name && (check.status === undefined || call.status === check.status));
        checks.push({ type: check.type, passed, detail: passed ? `Tool '${check.name}' was observed with the expected status.` : `Tool '${check.name}' was not observed with the expected status.` });
      } else if (check.type === "http_status") {
        const url = await validateNetworkUrl(check.url);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.max(1000, Math.min(30000, check.timeoutMs ?? 10000)));
        try {
          const response = await fetch(url, { redirect: "manual", signal: controller.signal });
          if (response.status >= 300 && response.status < 400) throw new Error("Redirects are not accepted by HTTP acceptance checks");
          const expected = check.expectedStatus ?? 200;
          const body = check.bodyContains === undefined ? "" : await response.text();
          const passed = response.status === expected && (check.bodyContains === undefined || matchesText(body, check.bodyContains));
          checks.push({ type: check.type, passed, detail: passed ? `HTTP ${response.status} matched the acceptance criteria.` : `HTTP ${response.status} did not match expected status/body criteria.` });
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch (error) {
      checks.push({ type: check.type, passed: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const mode = contract.mode ?? "all";
  const independentTypes = new Set(["file_exists", "file_contains", "http_status", "tool_called"]);
  const independentEvidencePassed = checks.some((item) => independentTypes.has(item.type) && item.passed);
  const modePassed = mode === "any" ? checks.some((item) => item.passed) : checks.length > 0 && checks.every((item) => item.passed);
  // Text-only success can never override failed artifact / tool / HTTP evidence, even in `any` mode.
  const passed = modePassed && independentEvidencePassed;
  return {
    passed,
    reason: passed ? `Acceptance contract passed (${mode} mode).` : `Acceptance contract failed (${mode} mode).`,
    checks,
  };
}
