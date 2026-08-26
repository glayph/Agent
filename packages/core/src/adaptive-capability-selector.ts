import type { ToolDefinition } from "./mcp/contracts/tools.js";
import type { AgentRouteDecision } from "./agent-router.js";
import type { AgentTaskProfile } from "./task-profile.js";
import { detectDeterministicIntent } from "./deterministic-intent.js";
import {
  globalContextualToolPruner,
  type ContextualToolPruner,
  type Tool,
} from "./contextual-tool-pruner.js";

export interface AdaptiveCapabilitySelection {
  context: string;
  selectedTools: ToolDefinition[];
  selectedToolNames: string[];
  selectedSkills: string[];
  confidence: number;
  rationale: string[];
}

export interface AdaptiveCapabilityOptions {
  maxTools?: number;
  minScore?: number;
}

function toolName(tool: ToolDefinition): string {
  return tool.function.name;
}

function asPrunerTool(tool: ToolDefinition): Tool {
  return {
    name: tool.function.name,
    description: tool.function.description,
  };
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ");
}

function explicitToolNames(userMessage: string): Set<string> {
  const intent = detectDeterministicIntent(userMessage);
  if (!intent) return new Set<string>();
  if (intent.kind === "web_search") return new Set(["web_search"]);
  return new Set(["file_write", "file_read"]);
}

function includesTerm(text: string, term: string): boolean {
  const normalizedText = normalize(text);
  const normalizedTerm = normalize(term);
  return Boolean(normalizedTerm) && normalizedText.includes(normalizedTerm);
}

function isSafeForAmbiguousTurn(name: string): boolean {
  const normalized = normalize(name);
  return !/(write|delete|remove|execute|shell|computer|browser|send|post|submit|install|runtime)/.test(
    normalized,
  );
}

function maxToolsFor(profile: AgentTaskProfile): number {
  if (
    profile.verificationDepth === "release" ||
    profile.complexity === "complex"
  ) {
    return 12;
  }
  if (profile.complexity === "standard") return 9;
  return 6;
}

/**
 * Resolve the smallest useful per-turn tool/skill surface.
 *
 * This is intentionally deterministic. The LLM can choose among the tools it
 * receives, but it cannot expand the catalog for a turn without another
 * deliberate routing decision by Miki.
 */
export function selectAdaptiveCapabilities(
  userMessage: string,
  allTools: ToolDefinition[],
  routeDecision: AgentRouteDecision,
  profile: AgentTaskProfile,
  options: AdaptiveCapabilityOptions = {},
  pruner: ContextualToolPruner = globalContextualToolPruner,
): AdaptiveCapabilitySelection {
  const maxTools = Math.max(1, options.maxTools ?? maxToolsFor(profile));
  const preferredTools = routeDecision.selected.tools || [];
  const preferredSkills = routeDecision.selected.skills || [];
  const candidates = pruner.getPrunedToolset(
    userMessage,
    allTools.map(asPrunerTool),
    {
      preferredTools,
      preferredSkills,
      maxTools,
      minScore: options.minScore,
    },
  );
  const candidateNames = new Set(candidates.map((item) => item.name || ""));
  const allByName = new Map(allTools.map((item) => [toolName(item), item]));
  const selected: ToolDefinition[] = [];
  const explicitTools = explicitToolNames(userMessage);
  const ambiguousTurn =
    profile.complexity === "simple" && profile.verificationDepth === "none";

  // Route preferences are authoritative when the registered tool exists.
  for (const preferred of preferredTools) {
    const definition = allByName.get(preferred);
    if (
      definition &&
      candidateNames.has(preferred) &&
      (!ambiguousTurn ||
        isSafeForAmbiguousTurn(preferred) ||
        explicitTools.has(preferred)) &&
      selected.length < maxTools &&
      !selected.some((item) => toolName(item) === preferred)
    ) {
      selected.push(definition);
    }
  }

  for (const candidate of candidates) {
    const name = candidate.name || "";
    const definition = allByName.get(name);
    if (
      definition &&
      candidateNames.has(name) &&
      (!ambiguousTurn ||
        isSafeForAmbiguousTurn(name) ||
        explicitTools.has(name)) &&
      !selected.some((item) => toolName(item) === name) &&
      selected.length < maxTools
    ) {
      selected.push(definition);
    }
  }

  // Explicit user intent is authoritative for the narrowly recognized safe
  // operations. Add the required tools even if heuristic ranking omitted them.
  for (const explicit of explicitTools) {
    const definition = allByName.get(explicit);
    if (
      definition &&
      !selected.some((item) => toolName(item) === explicit) &&
      selected.length < maxTools
    ) {
      selected.push(definition);
    }
  }

  // Keep a read-only recovery path if the heuristic is uncertain. Do not add
  // mutation or desktop-control tools as fallbacks.
  for (const fallback of ["file_read", "memory_search", "ask_user"]) {
    const definition = allByName.get(fallback);
    if (
      definition &&
      !selected.some((item) => toolName(item) === fallback) &&
      selected.length < maxTools
    ) {
      selected.push(definition);
    }
  }

  const topCandidateScore = candidates.length > 0 ? 0.5 : 0;
  const routeEvidence = routeDecision.reasons.length > 0 ? 0.3 : 0;
  const selectedEvidence = selected.length > 0 ? 0.2 : 0;
  const confidence = Number(
    Math.min(1, topCandidateScore + routeEvidence + selectedEvidence).toFixed(
      2,
    ),
  );
  const rationale = [
    `context:${pruner.inferTaskContext(userMessage)}`,
    `specialist:${routeDecision.selected.id}`,
    `tool_budget:${maxTools}`,
    selected.length < allTools.length
      ? `pruned:${allTools.length - selected.length}`
      : "catalog:full",
  ];
  if (explicitTools.size > 0) {
    rationale.push(`explicit_tools:${[...explicitTools].join(",")}`);
  }
  if (
    preferredTools.some((item) =>
      selected.some((tool) => toolName(tool) === item),
    )
  ) {
    rationale.push("specialist_tools_prioritized");
  }
  if (preferredSkills.length > 0) {
    rationale.push(`skills:${preferredSkills.join(",")}`);
  }

  return {
    context: pruner.inferTaskContext(userMessage),
    selectedTools: selected,
    selectedToolNames: selected.map(toolName),
    selectedSkills: preferredSkills,
    confidence,
    rationale,
  };
}

export function formatAdaptiveCapabilitySelection(
  selection: AdaptiveCapabilitySelection,
): string {
  return [
    "[Adaptive Capability Plan]",
    `context: ${selection.context}`,
    `confidence: ${selection.confidence}`,
    `selected_tools: ${selection.selectedToolNames.join(", ") || "none"}`,
    `selected_skills: ${selection.selectedSkills.join(", ") || "none"}`,
    `rationale: ${selection.rationale.join(", ")}`,
    "Use only the selected tools for this turn. If the request needs a capability outside this set, explain the gap or ask Miki to re-route before acting.",
  ].join("\n");
}

export function adaptiveToolNames(
  selection: AdaptiveCapabilitySelection,
): Set<string> {
  return new Set(selection.selectedToolNames);
}

export function toolMatchesSkill(tool: ToolDefinition, skill: string): boolean {
  return includesTerm(
    `${tool.function.name} ${tool.function.description}`,
    skill,
  );
}
