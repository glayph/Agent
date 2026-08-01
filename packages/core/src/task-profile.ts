export type AgentTaskComplexity = "simple" | "standard" | "complex";
export type AgentTaskSpeedClass = "instant" | "fastest" | "medium" | "heavy";
export type AgentVerificationDepth =
  "none" | "focused" | "integration" | "release";

export interface AgentTaskProfile {
  complexity: AgentTaskComplexity;
  speedClass: AgentTaskSpeedClass;
  expectedLatency: string;
  verificationDepth: AgentVerificationDepth;
  signals: string[];
  executionStyle: string;
  verification: string;
}

const COMPLEXITY_TERMS = [
  "architecture",
  "benchmark",
  "complex",
  "deploy",
  "enterprise",
  "integration",
  "Hiro",
  "migration",
  "perfect",
  "production",
  "refactor",
  "roadmap",
  "workflow",
];

const IMPLEMENTATION_TERMS = [
  "add",
  "build",
  "change",
  "code",
  "create",
  "debug",
  "edit",
  "fix",
  "implement",
  "test",
  "update",
  "write",
];

const FAST_TASK_TERMS = [
  "bug",
  "config",
  "docs",
  "document",
  "edit",
  "fix",
  "known bug",
  "route",
  "small",
  "text",
  "update",
];

const MEDIUM_TASK_TERMS = [
  "backend",
  "channel",
  "contract",
  "dashboard",
  "integration",
  "marketplace",
  "multi-file",
  "onboarding",
  "plugin",
  "runtime",
  "smoke",
];

const HEAVY_TASK_TERMS = [
  "architecture hardening",
  "benchmark",
  "full channel",
  "Hiro",
  "large ui",
  "matrix",
  "release verification",
  "roadmap",
  "sandbox",
  "workflow overhaul",
];

const MULTI_STEP_TERMS = [
  "after",
  "and",
  "then",
  "multiple",
  "several",
  "তার পর",
  "এর পর",
  "সব",
];

const SPEED_TERMS = [
  "asap",
  "fast",
  "faster",
  "quick",
  "quickly",
  "speed",
  "superfast",
  "urgent",
  "দ্রুত",
  "তাড়াতাড়ি",
  "তারাতারি",
  "তাড়াতাড়ি",
];

function hasAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function countMatches(text: string, terms: string[]): number {
  return terms.reduce(
    (count, term) => count + (text.includes(term) ? 1 : 0),
    0,
  );
}

function verificationDepthFor(
  normalized: string,
  complexity: AgentTaskComplexity,
  signals: string[],
): AgentVerificationDepth {
  if (/\b(release|pack|verify:release|full audit|matrix)\b/.test(normalized)) {
    return "release";
  }
  if (
    /\b(integration|smoke|gateway|channel|runtime|plugin|dashboard|marketplace|onboarding)\b/.test(
      normalized,
    )
  ) {
    return "integration";
  }
  if (
    signals.includes("verification_needed") ||
    signals.includes("implementation_intent") ||
    complexity !== "simple"
  ) {
    return "focused";
  }
  return "none";
}

function speedClassFor(
  normalized: string,
  complexity: AgentTaskComplexity,
  signals: string[],
  verificationDepth: AgentVerificationDepth,
): AgentTaskSpeedClass {
  if (
    complexity === "simple" &&
    !signals.includes("implementation_intent") &&
    verificationDepth === "none"
  ) {
    return "instant";
  }
  if (verificationDepth === "release" || hasAny(normalized, HEAVY_TASK_TERMS)) {
    return "heavy";
  }
  if (
    verificationDepth === "integration" ||
    hasAny(normalized, MEDIUM_TASK_TERMS)
  ) {
    return "medium";
  }
  if (
    signals.includes("implementation_intent") ||
    hasAny(normalized, FAST_TASK_TERMS)
  ) {
    return "fastest";
  }
  return complexity === "standard" ? "medium" : "instant";
}

function expectedLatencyFor(speedClass: AgentTaskSpeedClass): string {
  if (speedClass === "instant") return "instant_to_seconds";
  if (speedClass === "fastest") return "seconds_to_few_minutes";
  if (speedClass === "medium") return "few_minutes_to_15_plus_minutes";
  return "15_plus_minutes_or_longer";
}

export function classifyAgentTask(message: string): AgentTaskProfile {
  const normalized = message.toLowerCase();
  const signals: string[] = [];
  let score = 0;

  if (message.length > 240) {
    score += 2;
    signals.push("long_request");
  }

  const complexMatches = countMatches(normalized, COMPLEXITY_TERMS);
  if (complexMatches > 0) {
    score += Math.min(4, complexMatches);
    signals.push("complexity_terms");
  }

  if (hasAny(normalized, IMPLEMENTATION_TERMS)) {
    score += 1;
    signals.push("implementation_intent");
  }

  if (hasAny(normalized, MULTI_STEP_TERMS)) {
    score += 1;
    signals.push("multi_step_language");
  }

  if (hasAny(normalized, SPEED_TERMS)) {
    signals.push("speed_priority");
  }

  if (/[`{}[\]();]/.test(message)) {
    score += 1;
    signals.push("technical_syntax");
  }

  if (/\b(test|verify|lint|build|smoke|audit)\b/i.test(message)) {
    score += 1;
    signals.push("verification_needed");
  }

  let complexity: AgentTaskComplexity;
  let executionStyle: string;
  let verification: string;

  if (score >= 4) {
    complexity = "complex";
    executionStyle =
      "Use a task graph, keep steps explicit, prefer cached context, execute safe reads in parallel, serialize writes, and verify each meaningful result.";
    verification =
      "Verification is required before final response; include command, file, API, browser, or metric evidence when available.";
  } else if (score >= 2) {
    complexity = "standard";
    executionStyle =
      "Use a short plan, gather only relevant context, apply scoped changes, and verify the changed surface.";
    verification =
      "Run focused verification when code, config, or runtime behavior changes.";
  } else {
    complexity = "simple";
    executionStyle =
      "Answer or act directly with minimal context and avoid unnecessary tool calls.";
    verification =
      "Verification is optional unless the task changes files or runtime state.";
  }

  const normalizedSignals = signals.length > 0 ? signals : ["low_complexity"];
  const verificationDepth = verificationDepthFor(
    normalized,
    complexity,
    normalizedSignals,
  );
  const speedClass = speedClassFor(
    normalized,
    complexity,
    normalizedSignals,
    verificationDepth,
  );

  return withSpeedGuidance({
    complexity,
    speedClass,
    expectedLatency: expectedLatencyFor(speedClass),
    verificationDepth,
    signals: normalizedSignals,
    executionStyle,
    verification,
  });
}

function withSpeedGuidance(profile: AgentTaskProfile): AgentTaskProfile {
  if (!profile.signals.includes("speed_priority")) return profile;
  return {
    ...profile,
    executionStyle: `Fast lane: use cached context, parallel safe reads, and avoid optional exploration. ${profile.executionStyle}`,
    verification: `Fail fast on weak evidence, then run the narrowest meaningful verification. ${profile.verification}`,
  };
}

export function formatAgentTaskProfile(profile: AgentTaskProfile): string {
  return [
    `[Task Profile]`,
    `complexity: ${profile.complexity}`,
    `speed_class: ${profile.speedClass}`,
    `expected_latency: ${profile.expectedLatency}`,
    `verification_depth: ${profile.verificationDepth}`,
    `signals: ${profile.signals.join(", ")}`,
    `execution: ${profile.executionStyle}`,
    `verification: ${profile.verification}`,
  ].join("\n");
}
