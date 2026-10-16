import type { EngineTool } from "../engine/types.js";
import { getPermissionLedger, type LearnedDecision, type PermissionLedger } from "./permission-ledger.js";

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`"${field}" is required.`);
  return value.trim();
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const CATEGORY_SCHEMA = {
  type: "string",
  description: "shell, file_write, file_delete, install, browser, computer_use, memory_write, goal_proposal, or tool:<name>.",
};

const MATCH_SCHEMA = {
  type: "string",
  description: "Optional text that must appear in the tool input (for example a command). Empty matches every call in the category.",
};

/** Tools the agent uses to record and apply what the user has taught it. */
export function createPermissionTools(ledger: PermissionLedger = getPermissionLedger()): EngineTool[] {
  return [
    {
      name: "permission_learn",
      description:
        "Record what the user has taught about acting on its own. Use decision=ask when the user wants to be asked before a kind of action, including after a mistake. Use decision=act when the user says to just do it. The most specific rule wins. Keep the user's words in note.",
      risk: "config_write",
      approval: "auto",
      parameters: {
        type: "object",
        required: ["category", "decision"],
        additionalProperties: false,
        properties: {
          category: CATEGORY_SCHEMA,
          match: MATCH_SCHEMA,
          decision: { type: "string", enum: ["ask", "act"] },
          note: { type: "string" },
        },
      },
      async execute(input) {
        const decision = input.decision;
        if (decision !== "ask" && decision !== "act") throw new Error('"decision" must be "ask" or "act".');
        const rule = ledger.learn({
          category: requiredText(input.category, "category"),
          match: optionalText(input.match),
          decision: decision as LearnedDecision,
          note: optionalText(input.note),
        });
        return { ok: true, rule };
      },
    },
    {
      name: "permission_grant_once",
      description:
        "Let one blocked call proceed after the user has clearly agreed. Use the same category and match as the blocked call, then retry it. The grant is used up by the next matching call.",
      risk: "config_write",
      approval: "auto",
      parameters: {
        type: "object",
        required: ["category"],
        additionalProperties: false,
        properties: { category: CATEGORY_SCHEMA, match: MATCH_SCHEMA },
      },
      async execute(input) {
        const grant = ledger.grantOnce(requiredText(input.category, "category"), optionalText(input.match));
        return { ok: true, grant };
      },
    },
    {
      name: "permission_forget",
      description:
        "Remove a learned rule when the user no longer wants a kind of action asked about. Use the same category and match as the rule.",
      risk: "config_write",
      approval: "auto",
      parameters: {
        type: "object",
        required: ["category"],
        additionalProperties: false,
        properties: { category: CATEGORY_SCHEMA, match: MATCH_SCHEMA },
      },
      async execute(input) {
        const removed = ledger.forget(requiredText(input.category, "category"), optionalText(input.match));
        return { ok: true, removed };
      },
    },
  ];
}
