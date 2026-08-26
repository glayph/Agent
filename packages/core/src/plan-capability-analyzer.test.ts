import {
  analyzePlanCapabilities,
  formatPlanCapabilityReport,
} from "./plan-capability-analyzer.js";
import type { ToolDefinition } from "./mcp/contracts/tools.js";
import type { SkillMetadata } from "./skill-search.js";

const tools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "file_read",
      description: "Read project files",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_execute",
      description: "Run a verification command",
      parameters: { type: "object", properties: {} },
    },
  },
];

const skills: SkillMetadata[] = [
  {
    id: "web-development",
    name: "Web Development",
    description: "Build responsive React and TypeScript websites",
    category: "development",
    tags: ["web", "frontend", "react"],
    enabled: true,
    path: "/skills/web-development",
  },
];

describe("plan capability analyzer", () => {
  it("reports available capabilities without authorizing installation", () => {
    const report = analyzePlanCapabilities(
      "Design and build a responsive React website, then test it",
      { skills, tools },
      "standard/medium",
    );

    expect(report.autoInstallAllowed).toBe(false);
    expect(
      report.requirements.some((item) => item.id === "web-development"),
    ).toBe(true);
    expect(report.available.some((item) => item.id === "web-development")).toBe(
      true,
    );
    expect(
      report.requirements.find((item) => item.id === "project-files")
        ?.matchedIds,
    ).toContain("file_read");
    expect(
      report.requirements.find((item) => item.id === "runtime-verification")
        ?.matchedIds,
    ).toContain("shell_execute");
  });

  it("marks missing capability as approval-gated instead of installing it", () => {
    const report = analyzePlanCapabilities(
      "Build a website with a specialized animation plugin",
      { skills: [], tools: [] },
      "standard/medium",
    );

    expect(report.missing).toContain("web-development");
    expect(
      report.requirements.some((item) => item.id === "plugin-or-library"),
    ).toBe(true);
    expect(report.missing.every((item) => item.approvalRequired)).toBe(true);
    expect(report.planRules).toContain(
      "Do not install, download, authenticate or deploy during planning.",
    );
  });

  it("formats a compact human-readable plan report", () => {
    const report = analyzePlanCapabilities("Create a website", {
      skills,
      tools,
    });
    const formatted = formatPlanCapabilityReport(report);

    expect(formatted).toContain("[Plan Capability Requirements]");
    expect(formatted).toContain("online_research_recommended:");
    expect(formatted).toContain("No installation or download is authorized");
  });
});
EOF;
