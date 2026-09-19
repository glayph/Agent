/**
 * Plan-time capability analysis for Agent Miki.
 *
 * This module deliberately does not install, download, or execute anything.
 * It only explains what a disciplined developer would need before starting a
 * task, compares that need with the currently available catalog, and marks
 * actions that require explicit approval.
 */

import type { ToolDefinition } from "./mcp/contracts/tools.js";
import type { SkillMetadata } from "./skill-search.js";

export type CapabilityKind =
  "skill" | "tool" | "plugin" | "library" | "online_resource" | "access";

export type CapabilityStatus =
  | "available"
  | "partially_available"
  | "missing"
  | "approval_required"
  | "not_needed";

export type CapabilityRisk = "low" | "medium" | "high";

export interface CapabilityRequirement {
  id: string;
  kind: CapabilityKind;
  label: string;
  reason: string;
  status: CapabilityStatus;
  risk: CapabilityRisk;
  matchedIds: string[];
  suggestedSources: string[];
  installSpec?: string;
  approvalRequired: boolean;
}

export interface CapabilityInventory {
  skills: SkillMetadata[];
  tools: ToolDefinition[];
}

export interface PlanCapabilityReport {
  schemaVersion: 1;
  taskClass: string;
  summary: string;
  planRules: string[];
  requirements: CapabilityRequirement[];
  available: CapabilityRequirement[];
  missing: CapabilityRequirement[];
  approvalRequired: CapabilityRequirement[];
  onlineResearchRecommended: boolean;
  autoInstallAllowed: false;
}

interface RequirementSeed {
  id: string;
  kind: CapabilityKind;
  label: string;
  reason: string;
  risk: CapabilityRisk;
  terms: string[];
  suggestedSources: string[];
  installSpec?: string;
  approvalRequired?: boolean;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#.-]+/g, " ")
    .trim();
}

function hasAny(text: string, terms: string[]): boolean {
  const normalized = normalize(text);
  return terms.some((term) => normalized.includes(normalize(term)));
}

function toolName(tool: ToolDefinition): string {
  return tool.function.name;
}

function toolText(tool: ToolDefinition): string {
  return normalize(`${tool.function.name} ${tool.function.description || ""}`);
}

function skillText(skill: SkillMetadata): string {
  return normalize(
    `${skill.id} ${skill.name} ${skill.description} ${skill.category} ${(skill.tags || []).join(" ")}`,
  );
}

function matchTools(tools: ToolDefinition[], terms: string[]): string[] {
  return tools
    .filter((tool) => hasAny(toolText(tool), terms))
    .map(toolName)
    .slice(0, 8);
}

function matchSkills(skills: SkillMetadata[], terms: string[]): string[] {
  return skills
    .filter((skill) => skill.enabled && hasAny(skillText(skill), terms))
    .map((skill) => skill.id)
    .slice(0, 8);
}

function buildSeeds(message: string): RequirementSeed[] {
  const seeds: RequirementSeed[] = [
    {
      id: "requirements-analysis",
      kind: "skill",
      label: "Requirements analysis",
      reason:
        "Understand the requested outcome, constraints, scope and acceptance criteria before building.",
      risk: "low",
      terms: [
        "analy",
        "requirement",
        "spec",
        "website",
        "web app",
        "design",
        "build",
        "develop",
      ],
      suggestedSources: ["bundled planning capability"],
    },
    {
      id: "implementation",
      kind: "skill",
      label: "Implementation capability",
      reason:
        "Write or modify the smallest clean implementation that satisfies the plan.",
      risk: "low",
      terms: [
        "code",
        "build",
        "develop",
        "implement",
        "website",
        "web app",
        "react",
        "frontend",
        "backend",
      ],
      suggestedSources: ["bundled development capability"],
    },
    {
      id: "verification",
      kind: "skill",
      label: "Testing and verification",
      reason:
        "Verify behavior, regressions, accessibility or acceptance criteria before delivery.",
      risk: "low",
      terms: [
        "test",
        "verify",
        "website",
        "web app",
        "code",
        "build",
        "deploy",
        "fix",
        "debug",
      ],
      suggestedSources: ["bundled testing capability"],
    },
    {
      id: "web-development",
      kind: "skill",
      label: "Web development",
      reason:
        "The request concerns a website, web application, interface or frontend implementation.",
      risk: "low",
      terms: [
        "website",
        "web site",
        "web app",
        "frontend",
        "front end",
        "react",
        "next",
        "vite",
        "html",
        "css",
        "javascript",
        "typescript",
        "tailwind",
        "landing page",
        "responsive",
        "ui",
        "ux",
      ],
      suggestedSources: [
        "bundled web-development skill",
        "approved skill registry",
      ],
      installSpec: "registry:web-development",
    },
    {
      id: "plugin-or-library",
      kind: "plugin",
      label: "Additional plugin or library",
      reason:
        "Only acquire a package or plugin when the requirements prove that the existing stack cannot satisfy the task.",
      risk: "medium",
      terms: [
        "plugin",
        "extension",
        "package",
        "library",
        "npm",
        "pip",
        "dependency",
        "install",
      ],
      suggestedSources: [
        "official package registry",
        "official project repository",
      ],
      installSpec: "approval-required:requested-plugin-or-library",
      approvalRequired: true,
    },
    {
      id: "asset-research",
      kind: "online_resource",
      label: "Design asset or reference research",
      reason:
        "Find compatible, licensed images, icons, fonts or design references only if the brief needs them.",
      risk: "medium",
      terms: [
        "image",
        "icon",
        "font",
        "asset",
        "template",
        "illustration",
        "logo",
        "reference",
      ],
      suggestedSources: [
        "official asset source",
        "licensed/open-licensed repository",
      ],
    },
    {
      id: "source-research",
      kind: "online_resource",
      label: "Online documentation or asset research",
      reason:
        "Use current official documentation, compatible assets or references only when the task needs them.",
      risk: "medium",
      terms: [
        "latest",
        "documentation",
        "library",
        "website",
        "web app",
        "design",
        "image",
        "icon",
        "asset",
        "research",
        "reference",
      ],
      suggestedSources: [
        "official documentation",
        "official package registry",
        "licensed asset source",
      ],
    },
    {
      id: "project-files",
      kind: "tool",
      label: "Project file access",
      reason:
        "Inspect the existing project before changing it and keep changes connected to the source tree.",
      risk: "medium",
      terms: [
        "code",
        "build",
        "develop",
        "implement",
        "website",
        "web app",
        "project",
        "fix",
        "refactor",
      ],
      suggestedSources: ["file_read", "file_write", "file_edit"],
    },
    {
      id: "runtime-verification",
      kind: "tool",
      label: "Runtime and test execution",
      reason:
        "Run only the required checks after implementation; do not claim success without evidence.",
      risk: "medium",
      terms: [
        "test",
        "verify",
        "build",
        "run",
        "debug",
        "deploy",
        "website",
        "web app",
      ],
      suggestedSources: ["shell_execute", "test runner"],
    },
    {
      id: "external-access",
      kind: "access",
      label: "External account or secret access",
      reason:
        "Only needed if the requested implementation explicitly depends on a private service, deployment account or API.",
      risk: "high",
      terms: [
        "deploy",
        "publish",
        "hosting",
        "api",
        "login",
        "account",
        "database",
        "payment",
        "private",
      ],
      suggestedSources: ["user-provided connector or secret manager"],
      approvalRequired: true,
    },
  ];

  return seeds.filter((seed) => hasAny(message, seed.terms));
}

function classifyStatus(
  seed: RequirementSeed,
  matchedIds: string[],
): CapabilityStatus {
  if (seed.approvalRequired) return "approval_required";
  if (matchedIds.length > 0) return "available";
  if (seed.kind === "online_resource") return "partially_available";
  return "missing";
}

export function analyzePlanCapabilities(
  message: string,
  inventory: CapabilityInventory,
  taskClass = "general",
): PlanCapabilityReport {
  const requirements = buildSeeds(message).map(
    (seed): CapabilityRequirement => {
      const matchedIds =
        seed.kind === "skill"
          ? matchSkills(inventory.skills, seed.terms)
          : seed.kind === "tool"
            ? matchTools(inventory.tools, seed.terms)
            : [];
      const status = classifyStatus(seed, matchedIds);
      const approvalRequired =
        Boolean(seed.approvalRequired) || status === "missing";
      return {
        id: seed.id,
        kind: seed.kind,
        label: seed.label,
        reason: seed.reason,
        status,
        risk: seed.risk,
        matchedIds,
        suggestedSources: seed.suggestedSources,
        installSpec: seed.installSpec,
        approvalRequired,
      };
    },
  );

  const available = requirements.filter(
    (item) =>
      item.status === "available" || item.status === "partially_available",
  );
  const missing = requirements.filter(
    (item) => item.status === "missing" || item.status === "approval_required",
  );
  const approvalRequired = requirements.filter((item) => item.approvalRequired);
  const onlineResearchRecommended = requirements.some(
    (item) => item.kind === "online_resource",
  );

  const missingText = missing.length
    ? ` Missing or gated capabilities: ${missing.map((item) => item.label).join(", ")}.`
    : " No capability installation is required before starting.";

  return {
    schemaVersion: 1,
    taskClass,
    summary: `Plan assessed ${requirements.length} capability requirement(s).${missingText}`,
    planRules: [
      "Understand requirements and constraints before implementation.",
      "When a plan is shown to the user, include the required, available, missing and approval-gated capabilities.",
      "Prefer the smallest existing capability set that can complete the task.",
      "Do not install, download, authenticate or deploy during planning.",
      "Ask for approval before acquiring a missing skill, plugin, library or access credential.",
      "Implement, test, verify and document evidence before delivery.",
    ],
    requirements,
    available,
    missing,
    approvalRequired,
    onlineResearchRecommended,
    autoInstallAllowed: false,
  };
}

export function formatPlanCapabilityReport(
  report: PlanCapabilityReport,
): string {
  const rows = report.requirements.map((item) => {
    const matches = item.matchedIds.length
      ? item.matchedIds.join(", ")
      : "none";
    const sources = item.suggestedSources.join(", ");
    return `- ${item.label} | ${item.kind} | ${item.status} | ${item.approvalRequired ? "approval required" : "no approval required"} | available: ${matches} | source: ${sources}`;
  });

  return [
    "[Plan Capability Requirements]",
    report.summary,
    `task_class: ${report.taskClass}`,
    `online_research_recommended: ${report.onlineResearchRecommended}`,
    "The plan is analysis-only. No installation or download is authorized at this stage.",
    ...rows,
  ].join("\n");
}
