import fs from "node:fs";
import path from "node:path";

// The permission ledger stores what the user has taught Miki about acting on
// its own. There are no built-in restrictions: a call is allowed unless a rule
// learned from user feedback says to ask first. A one-time grant lets a single
// asked-about call proceed after the user agrees.

export type LearnedDecision = "act" | "ask";

export interface LearnedRule {
  /** Tool category such as "shell", "file_delete", or "tool:<name>". */
  category: string;
  /** Case-insensitive text that must appear in the tool input. Empty matches every input. */
  match: string;
  decision: LearnedDecision;
  /** The user's words or the reason for the rule, kept for audit. */
  note: string;
  updatedAt: string;
}

export interface OnceGrant {
  category: string;
  match: string;
  createdAt: string;
}

export interface LedgerVerdict {
  mode: "auto" | "block";
  reason: string;
}

interface LedgerFile {
  version: 1;
  rules: LearnedRule[];
  grants: OnceGrant[];
}

const CATEGORY_BY_TOOL: Record<string, string> = {
  shell_execute: "shell",
  terminal_run: "shell",
  terminal_kill: "shell",
  file_write: "file_write",
  file_mkdir: "file_write",
  file_delete: "file_delete",
  runtime_ensure: "install",
  memory_add: "memory_write",
  autonomy_propose_goal: "goal_proposal",
};

export function categoryForTool(toolName: string): string {
  const mapped = CATEGORY_BY_TOOL[toolName];
  if (mapped) return mapped;
  if (toolName.startsWith("browser_")) return "browser";
  if (toolName.startsWith("computer_")) return "computer_use";
  return `tool:${toolName}`;
}

function inputText(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? "";
  } catch {
    return "";
  }
}

function matches(entry: { match: string }, haystack: string): boolean {
  return entry.match === "" || haystack.toLowerCase().includes(entry.match.toLowerCase());
}

function isRule(value: unknown): value is LearnedRule {
  const rule = value as LearnedRule;
  return (
    typeof rule?.category === "string" &&
    typeof rule?.match === "string" &&
    (rule?.decision === "act" || rule?.decision === "ask") &&
    typeof rule?.note === "string" &&
    typeof rule?.updatedAt === "string"
  );
}

function isGrant(value: unknown): value is OnceGrant {
  const grant = value as OnceGrant;
  return typeof grant?.category === "string" && typeof grant?.match === "string" && typeof grant?.createdAt === "string";
}

function readLedgerFile(filePath: string): LedgerFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<LedgerFile>;
    return {
      version: 1,
      rules: Array.isArray(parsed.rules) ? parsed.rules.filter(isRule) : [],
      grants: Array.isArray(parsed.grants) ? parsed.grants.filter(isGrant) : [],
    };
  } catch {
    // A missing or unreadable file means nothing has been learned yet.
    return { version: 1, rules: [], grants: [] };
  }
}

export class PermissionLedger {
  private readonly filePath: string;
  private data: LedgerFile;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = readLedgerFile(filePath);
  }

  /** Decide whether a tool call may run now, based on what the user has taught. */
  evaluate(toolName: string, input: unknown): LedgerVerdict {
    const category = categoryForTool(toolName);
    const haystack = inputText(input);
    const rule = this.strongestRule(category, haystack);
    if (!rule || rule.decision === "act") {
      return { mode: "auto", reason: "No learned restriction applies." };
    }
    const grantIndex = this.data.grants.findIndex(
      (grant) => grant.category === category && matches(grant, haystack),
    );
    if (grantIndex >= 0) {
      this.data.grants.splice(grantIndex, 1);
      this.persist();
      return { mode: "auto", reason: "The user granted this one action." };
    }
    const scope = rule.match ? ` matching "${rule.match}"` : "";
    return {
      mode: "block",
      reason:
        `The user asked to be asked before "${category}" actions${scope}. Note: ${rule.note || "no note"}. ` +
        "Ask the user in your reply and wait for a clear yes. After a yes, call permission_grant_once " +
        "with the same category and match, then retry this action.",
    };
  }

  /** Store or replace the rule for a category and match. */
  learn(input: { category: string; match?: string; decision: LearnedDecision; note?: string }): LearnedRule {
    const category = input.category.trim();
    if (!category) throw new Error("category is required.");
    const match = (input.match ?? "").trim();
    const rule: LearnedRule = {
      category,
      match,
      decision: input.decision,
      note: (input.note ?? "").trim().slice(0, 500),
      updatedAt: new Date().toISOString(),
    };
    this.data.rules = this.data.rules.filter((entry) => !(entry.category === category && entry.match === match));
    this.data.rules.push(rule);
    this.persist();
    return rule;
  }

  /** Remove a learned rule. Returns true when one was removed. */
  forget(category: string, match = ""): boolean {
    const before = this.data.rules.length;
    const target = category.trim();
    const wanted = match.trim();
    this.data.rules = this.data.rules.filter((entry) => !(entry.category === target && entry.match === wanted));
    const removed = this.data.rules.length !== before;
    if (removed) this.persist();
    return removed;
  }

  /** Allow the next matching call once, after the user agreed to it. */
  grantOnce(category: string, match = ""): OnceGrant {
    const grant: OnceGrant = {
      category: category.trim(),
      match: match.trim(),
      createdAt: new Date().toISOString(),
    };
    if (!grant.category) throw new Error("category is required.");
    this.data.grants.push(grant);
    this.persist();
    return grant;
  }

  rules(): LearnedRule[] {
    return this.data.rules.map((rule) => ({ ...rule }));
  }

  grants(): OnceGrant[] {
    return this.data.grants.map((grant) => ({ ...grant }));
  }

  private strongestRule(category: string, haystack: string): LearnedRule | undefined {
    let best: LearnedRule | undefined;
    for (const rule of this.data.rules) {
      if (rule.category !== category || !matches(rule, haystack)) continue;
      // The most specific match wins, so "act for npm test" beats "ask for shell".
      if (!best || rule.match.length > best.match.length) best = rule;
    }
    return best;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, this.filePath);
  }
}

/** Learned rules live with Miki's identity files, so they travel with the identity. */
export function defaultLedgerPath(): string {
  const explicit = process.env.MIKI_PERMISSIONS_FILE?.trim();
  const identityDir = process.env.MIKI_IDENTITY_DIR?.trim() || path.join(process.cwd(), "identity");
  return explicit || path.join(identityDir, "learned-rules.json");
}

let shared: PermissionLedger | undefined;

/** The ledger used by the engine for every run, chat and autonomy alike. */
export function getPermissionLedger(): PermissionLedger {
  if (!shared) shared = new PermissionLedger(defaultLedgerPath());
  return shared;
}
