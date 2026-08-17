import {
  classifyAgentTask,
  type AgentTaskComplexity,
  type AgentTaskProfile,
} from "./task-profile.js";

type JsonRecord = Record<string, unknown>;

export interface AgentSpecialistDefinition {
  id: string;
  name: string;
  description: string;
  persona?: string;
  capabilities: string[];
  keywords: string[];
  signals: string[];
  complexities: AgentTaskComplexity[];
  tools: string[];
  skills: string[];
  priority: number;
  enabled: boolean;
}

export interface AgentRouteCandidate {
  specialist: AgentSpecialistDefinition;
  score: number;
  reasons: string[];
}

export interface AgentRouteDecision {
  enabled: boolean;
  mode: "single_orchestrator" | "multi_agent";
  selected: AgentSpecialistDefinition;
  profile: AgentTaskProfile;
  candidates: AgentRouteCandidate[];
  reasons: string[];
  /** Set by the delegator after an instance is chosen / spawned */
  targetInstanceId?: string;
}

interface AgentRouterConfig {
  enabled?: boolean;
  default_agent?: string;
  min_score?: number;
}

const DEFAULT_MIN_SCORE = 2;

const DEFAULT_SPECIALISTS: AgentSpecialistDefinition[] = [
  // -------------------------------------------------------------------------
  // Miki — General coordinator / triage (original specialist, unchanged)
  // -------------------------------------------------------------------------
  {
    id: "miki",
    name: "Miki",
    description:
      "General coordinator and triage agent. Routes simple tasks and handles conversation, planning, and multi-domain coordination.",
    persona:
      "Choose the lightest reliable path, gather only relevant context, apply scoped changes, and verify meaningful results before final output.",
    capabilities: [
      "coordination",
      "conversation",
      "triage",
      "code",
      "debug",
      "test",
      "refactor",
      "integration",
      "research",
      "compare",
      "audit",
      "marketplace",
      "planning",
      "workflow",
      "roadmap",
      "architecture",
    ],
    keywords: [
      "architecture",
      "add",
      "audit",
      "build",
      "code",
      "compare",
      "current",
      "debug",
      "fix",
      "goal",
      "implement",
      "latest",
      "marketplace",
      "plan",
      "production",
      "refactor",
      "research",
      "roadmap",
      "runtime",
      "test",
      "typescript",
      "api",
      "verify",
      "workflow",
    ],
    signals: [
      "low_complexity",
      "implementation_intent",
      "technical_syntax",
      "verification_needed",
      "complexity_terms",
      "multi_step_language",
    ],
    complexities: ["simple", "standard", "complex"],
    tools: [
      "shell_execute",
      "file_read",
      "file_write",
      "web_search",
      "scrape_page",
      "project_workflow_create",
    ],
    skills: [],
    priority: 10,
    enabled: true,
  },

  // -------------------------------------------------------------------------
  // Sage — Deep research & analysis specialist
  // -------------------------------------------------------------------------
  {
    id: "sage",
    name: "Sage",
    description:
      "Deep research and analysis specialist. Excels at web research, document analysis, competitive comparison, and synthesising large amounts of information into structured reports.",
    persona:
      "Gather comprehensive evidence before forming conclusions. Prioritise primary sources, cross-check claims, and surface key insights with citations. Return structured, actionable summaries.",
    capabilities: [
      "research",
      "analysis",
      "investigation",
      "summarisation",
      "compare",
      "audit",
      "documentation",
      "fact-checking",
      "competitive-analysis",
      "literature-review",
    ],
    keywords: [
      "research",
      "analyse",
      "analyze",
      "investigate",
      "find",
      "discover",
      "compare",
      "evaluate",
      "summarise",
      "summarize",
      "report",
      "document",
      "evidence",
      "source",
      "citation",
      "literature",
      "competitive",
      "market",
      "benchmark",
      "survey",
      "review",
    ],
    signals: ["complexity_terms", "multi_step_language", "verification_needed"],
    complexities: ["standard", "complex"],
    tools: ["web_search", "scrape_page", "file_read"],
    skills: ["research", "summarization"],
    priority: 7,
    enabled: true,
  },

  // -------------------------------------------------------------------------
  // Forge — Code generation & execution specialist
  // -------------------------------------------------------------------------
  {
    id: "forge",
    name: "Forge",
    description:
      "Code generation and execution specialist. Writes, tests, refactors, and executes code. Manages project scaffolding and CI/CD workflow creation.",
    persona:
      "Write the minimal, correct implementation first. Validate with tests before committing. Prefer existing patterns over novel ones. Keep diffs small and focused.",
    capabilities: [
      "code",
      "codegen",
      "execution",
      "testing",
      "refactor",
      "debug",
      "scaffolding",
      "build",
      "deploy",
      "ci",
      "workflow",
      "shell",
      "scripting",
    ],
    keywords: [
      "code",
      "generate",
      "write",
      "implement",
      "build",
      "compile",
      "run",
      "execute",
      "test",
      "debug",
      "refactor",
      "fix",
      "scaffold",
      "deploy",
      "script",
      "function",
      "class",
      "module",
      "typescript",
      "javascript",
      "python",
      "golang",
      "shell",
      "bash",
    ],
    signals: [
      "implementation_intent",
      "technical_syntax",
      "verification_needed",
      "low_complexity",
    ],
    complexities: ["simple", "standard", "complex"],
    tools: [
      "shell_execute",
      "file_write",
      "file_read",
      "project_workflow_create",
    ],
    skills: ["code-generation", "testing"],
    priority: 8,
    enabled: true,
  },

  // -------------------------------------------------------------------------
  // Scout — Monitoring, health & metrics specialist
  // -------------------------------------------------------------------------
  {
    id: "scout",
    name: "Scout",
    description:
      "Monitoring, health, and metrics specialist. Tracks agent health, collects performance metrics, manages scheduled tasks, and alerts on anomalies.",
    persona:
      "Observe continuously, alert precisely. Surface the most actionable signal with minimum noise. Prefer trends over single data points. Escalate only genuine anomalies.",
    capabilities: [
      "monitoring",
      "health",
      "metrics",
      "scheduling",
      "alerting",
      "diagnostics",
      "observability",
      "performance",
      "uptime",
      "logging",
    ],
    keywords: [
      "health",
      "monitor",
      "status",
      "metric",
      "performance",
      "uptime",
      "alert",
      "schedule",
      "diagnose",
      "log",
      "trace",
      "latency",
      "error rate",
      "throughput",
      "dashboard",
      "heartbeat",
      "check",
    ],
    signals: ["verification_needed", "complexity_terms"],
    complexities: ["simple", "standard"],
    tools: ["health_checker", "metrics_collector", "scheduler", "file_read"],
    skills: ["monitoring", "alerting"],
    priority: 6,
    enabled: true,
  },
];

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(stringValue).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function complexityArray(value: unknown): AgentTaskComplexity[] {
  return stringArray(value).filter(
    (item): item is AgentTaskComplexity =>
      item === "simple" || item === "standard" || item === "complex",
  );
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "specialist";
}

function specialistFromRecord(
  raw: JsonRecord,
  fallbackId: string,
): AgentSpecialistDefinition | null {
  const id = normalizeId(stringValue(raw.id) || fallbackId);
  const name = stringValue(raw.name) || id;
  const match = isRecord(raw.match) ? raw.match : {};
  const capabilities = stringArray(raw.capabilities);
  const keywords = [
    ...stringArray(raw.keywords),
    ...stringArray(match.keywords),
  ];
  const signals = [...stringArray(raw.signals), ...stringArray(match.signals)];
  const complexities = [
    ...complexityArray(raw.complexities),
    ...complexityArray(match.complexities),
    ...complexityArray(match.complexity),
  ];

  return {
    id,
    name,
    description:
      stringValue(raw.description) ||
      stringValue(match.description) ||
      `${name} specialist`,
    persona: stringValue(raw.persona) || undefined,
    capabilities,
    keywords,
    signals,
    complexities,
    tools: stringArray(raw.tools),
    skills: stringArray(raw.skills),
    priority: numberValue(raw.priority, 0),
    enabled: raw.enabled !== false,
  };
}

function configuredSpecialists(
  config: JsonRecord,
): AgentSpecialistDefinition[] {
  const agents = isRecord(config.agents) ? config.agents : {};
  const rawSpecialists = agents.specialists;
  if (Array.isArray(rawSpecialists)) {
    return rawSpecialists
      .flatMap((item, index) =>
        isRecord(item)
          ? [specialistFromRecord(item, `specialist_${index + 1}`)]
          : [],
      )
      .filter((item): item is AgentSpecialistDefinition => Boolean(item));
  }
  if (isRecord(rawSpecialists)) {
    return Object.entries(rawSpecialists)
      .flatMap(([id, item]) =>
        isRecord(item) ? [specialistFromRecord(item, id)] : [],
      )
      .filter((item): item is AgentSpecialistDefinition => Boolean(item));
  }
  return [];
}

function mergeSpecialists(
  configured: AgentSpecialistDefinition[],
): AgentSpecialistDefinition[] {
  const merged = new Map<string, AgentSpecialistDefinition>();
  for (const specialist of DEFAULT_SPECIALISTS) {
    merged.set(specialist.id, specialist);
  }
  for (const specialist of configured) {
    const existing = merged.get(specialist.id);
    merged.set(
      specialist.id,
      existing ? { ...existing, ...specialist } : specialist,
    );
  }
  return Array.from(merged.values()).filter((item) => item.enabled);
}

function routerConfig(config: JsonRecord): AgentRouterConfig {
  const agents = isRecord(config.agents) ? config.agents : {};
  return isRecord(agents.router) ? (agents.router as AgentRouterConfig) : {};
}

function scoreSpecialist(
  specialist: AgentSpecialistDefinition,
  message: string,
  profile: AgentTaskProfile,
): AgentRouteCandidate {
  const normalized = message.toLowerCase();
  const reasons: string[] = [];
  let score = specialist.priority / 10;

  for (const keyword of specialist.keywords) {
    if (normalized.includes(keyword.toLowerCase())) {
      score += 2;
      reasons.push(`keyword:${keyword}`);
    }
  }

  for (const capability of specialist.capabilities) {
    if (normalized.includes(capability.toLowerCase())) {
      score += 1.5;
      reasons.push(`capability:${capability}`);
    }
  }

  for (const signal of specialist.signals) {
    if (profile.signals.includes(signal)) {
      score += 1.5;
      reasons.push(`signal:${signal}`);
    }
  }

  if (specialist.complexities.includes(profile.complexity)) {
    score += 1;
    reasons.push(`complexity:${profile.complexity}`);
  }

  return {
    specialist,
    score: Number(score.toFixed(2)),
    reasons,
  };
}

export function routeAgentTask(
  message: string,
  config: JsonRecord = {},
  profile: AgentTaskProfile = classifyAgentTask(message),
): AgentRouteDecision {
  const routeConfig = routerConfig(config);
  const configured = configuredSpecialists(config);
  const specialists = mergeSpecialists(configured);
  const defaultId = normalizeId(routeConfig.default_agent || "miki");
  const fallback =
    specialists.find((item) => item.id === defaultId) ||
    specialists.find((item) => item.id === "miki") ||
    DEFAULT_SPECIALISTS[0];

  if (routeConfig.enabled === false) {
    return {
      enabled: false,
      mode: "single_orchestrator",
      selected: fallback,
      profile,
      candidates: [],
      reasons: ["router_disabled"],
    };
  }

  const candidates = specialists
    .map((specialist) => scoreSpecialist(specialist, message, profile))
    .sort(
      (a, b) =>
        b.score - a.score || b.specialist.priority - a.specialist.priority,
    );
  const minScore = Math.max(
    0,
    numberValue(routeConfig.min_score, DEFAULT_MIN_SCORE),
  );
  const best = candidates[0];
  const selected = best && best.score >= minScore ? best.specialist : fallback;
  const selectedCandidate = candidates.find(
    (candidate) => candidate.specialist.id === selected.id,
  );

  // Determine routing mode: use multi_agent when a non-default specialist is
  // selected with a strong enough score and multiple specialists are available.
  const isMultiAgentCapable = specialists.length > 1;
  const nonDefaultSelected =
    selected.id !== (routeConfig.default_agent ?? "miki");
  const mode: "single_orchestrator" | "multi_agent" =
    isMultiAgentCapable &&
    nonDefaultSelected &&
    selectedCandidate &&
    selectedCandidate.score >= minScore
      ? "multi_agent"
      : "single_orchestrator";

  return {
    enabled: true,
    mode,
    selected,
    profile,
    candidates,
    reasons:
      selectedCandidate && selectedCandidate.score >= minScore
        ? selectedCandidate.reasons
        : ["fallback_default_agent"],
  };
}

export function summarizeAgentRoute(decision: AgentRouteDecision) {
  return {
    enabled: decision.enabled,
    mode: decision.mode,
    agentId: decision.selected.id,
    agentName: decision.selected.name,
    complexity: decision.profile.complexity,
    speedClass: decision.profile.speedClass,
    expectedLatency: decision.profile.expectedLatency,
    verificationDepth: decision.profile.verificationDepth,
    reasons: decision.reasons,
  };
}

export function formatAgentRouteDecision(decision: AgentRouteDecision): string {
  const selected = decision.selected;
  const topCandidates = decision.candidates
    .slice(0, 3)
    .map(
      (candidate) =>
        `${candidate.specialist.id}:${candidate.score}(${candidate.reasons.join("|") || "no_match"})`,
    )
    .join(", ");
  return [
    "[Agent Route]",
    `enabled: ${decision.enabled}`,
    `mode: ${decision.mode}`,
    `selected: ${selected.id} (${selected.name})`,
    `complexity: ${decision.profile.complexity}`,
    `speed_class: ${decision.profile.speedClass}`,
    `expected_latency: ${decision.profile.expectedLatency}`,
    `verification_depth: ${decision.profile.verificationDepth}`,
    `reasons: ${decision.reasons.join(", ")}`,
    selected.persona ? `specialist_persona: ${selected.persona}` : "",
    selected.tools.length > 0
      ? `preferred_tools: ${selected.tools.join(", ")}`
      : "",
    selected.skills.length > 0
      ? `preferred_skills: ${selected.skills.join(", ")}`
      : "",
    topCandidates ? `candidates: ${topCandidates}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
