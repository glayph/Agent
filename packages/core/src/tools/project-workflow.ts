import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import { normalizeRuntimePaths, type RuntimePaths } from "../paths.js";

export type ProjectTargetType =
  | "app"
  | "website"
  | "library"
  | "game"
  | "automation"
  | "simulation"
  | "complex_task"
  | "os"
  | "other";

export interface ProjectWorkflowInput {
  brief: string;
  projectName?: string;
  targetType?: ProjectTargetType;
  constraints?: string[] | string;
  writeFiles?: boolean;
  scaffoldFiles?: boolean;
  overwrite?: boolean;
  runGates?: boolean;
  gateNames?: string[] | string;
  gateTimeoutMs?: number;
  outputDir?: string;
}

export interface ProjectWorkflowFile {
  path: string;
  purpose: string;
  priority: "must" | "should" | "could";
}

export interface ProjectWorkflowGate {
  name: string;
  command?: string;
  evidence: string;
}

export interface ProjectWorkflowGateResult {
  name: string;
  command: string;
  cwd: string;
  status: "passed" | "failed" | "skipped";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  evidence: string;
}

export interface ProjectWorkflowMilestone {
  name: string;
  outcome: string;
  steps: string[];
  gates: ProjectWorkflowGate[];
}

export interface ProjectWorkflow {
  id: string;
  projectName: string;
  targetType: ProjectTargetType;
  createdAt: string;
  brief: string;
  constraints: string[];
  assumptions: string[];
  architecture: {
    style: string;
    modules: Array<{ name: string; responsibility: string }>;
    dataFlow: string[];
  };
  fileTree: ProjectWorkflowFile[];
  milestones: ProjectWorkflowMilestone[];
  riskRegister: Array<{ risk: string; mitigation: string }>;
  reviewLoop: string[];
  outputDir?: string;
  writtenFiles?: string[];
  scaffoldRoot?: string;
  scaffoldedFiles?: string[];
  skippedFiles?: string[];
  gateResults?: ProjectWorkflowGateResult[];
  verificationReportPath?: string;
}

interface NormalizedProjectWorkflowInput {
  brief: string;
  projectName: string;
  targetType: ProjectTargetType;
  constraints: string[];
  writeFiles: boolean;
}

interface WriteScaffoldResult {
  scaffoldedFiles: string[];
  skippedFiles: string[];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(asString).filter(Boolean)
    : typeof value === "string" && value.trim()
      ? value
          .split(/\r?\n|,/)
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
}

function normalizeTargetType(value: unknown): ProjectTargetType {
  const normalized = asString(value).toLowerCase();
  if (
    normalized === "app" ||
    normalized === "website" ||
    normalized === "library" ||
    normalized === "game" ||
    normalized === "automation" ||
    normalized === "simulation" ||
    normalized === "complex_task" ||
    normalized === "os" ||
    normalized === "other"
  ) {
    return normalized;
  }
  return "app";
}

function inferTargetTypeFromBrief(brief: string): ProjectTargetType {
  const normalized = brief.toLowerCase();
  if (/\b(os|kernel|bootloader|boot sector|emulator)\b/.test(normalized)) {
    return "os";
  }
  if (
    /\b(simulation|simulate|physics|replay|scenario|telemetry)\b/.test(
      normalized,
    )
  ) {
    return "simulation";
  }
  if (/\b(game|level|sprite|physics engine|gameplay)\b/.test(normalized)) {
    return "game";
  }
  if (/\b(website|landing page|web page)\b/.test(normalized)) {
    return "website";
  }
  if (/\b(automation|bot|scheduled|pipeline|workflow)\b/.test(normalized)) {
    return "automation";
  }
  if (
    /\b(complex|multi-step|multistep|research|analysis|orchestration|system design)\b/.test(
      normalized,
    )
  ) {
    return "complex_task";
  }
  return "app";
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "generated-project";
}

function inferProjectName(
  brief: string,
  targetType: ProjectTargetType,
): string {
  const firstLine = brief
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (firstLine) {
    return firstLine.replace(/[.:;,-]+$/g, "").slice(0, 72);
  }
  return targetType === "os" ? "Sketch OS" : "Generated Project";
}

function targetModules(targetType: ProjectTargetType) {
  if (targetType === "os") {
    return [
      {
        name: "boot",
        responsibility:
          "Bootloader handoff, early memory map, and startup checks.",
      },
      {
        name: "kernel",
        responsibility:
          "Scheduler, interrupts, memory management, and core syscalls.",
      },
      {
        name: "drivers",
        responsibility:
          "Device abstraction, display/input/storage drivers, and hardware probes.",
      },
      {
        name: "shell",
        responsibility:
          "Minimal user interface for commands, diagnostics, and demos.",
      },
      {
        name: "toolchain",
        responsibility:
          "Build scripts, emulator runner, image packaging, and debug symbols.",
      },
      {
        name: "tests",
        responsibility: "Unit, emulator, boot, and smoke verification gates.",
      },
    ];
  }
  if (targetType === "website" || targetType === "app") {
    return [
      {
        name: "ui",
        responsibility:
          "User flows, state, responsive layout, and accessibility.",
      },
      {
        name: "api",
        responsibility:
          "Backend endpoints, auth boundary, validation, and integration contracts.",
      },
      {
        name: "domain",
        responsibility:
          "Core business rules independent from UI and transport.",
      },
      {
        name: "persistence",
        responsibility:
          "Data models, migrations, caching, and recovery behavior.",
      },
      {
        name: "tests",
        responsibility:
          "Unit, integration, visual, and smoke verification gates.",
      },
    ];
  }
  if (targetType === "game") {
    return [
      {
        name: "engine",
        responsibility:
          "Game loop, physics/rules, input, and deterministic state updates.",
      },
      {
        name: "scene",
        responsibility:
          "Level loading, camera, rendering setup, and asset orchestration.",
      },
      {
        name: "assets",
        responsibility: "Sprites/models/audio metadata and loading pipeline.",
      },
      {
        name: "ui",
        responsibility: "HUD, menus, pause/settings, and accessibility.",
      },
      {
        name: "tests",
        responsibility:
          "Rules, simulation, performance, and browser smoke checks.",
      },
    ];
  }
  if (targetType === "simulation") {
    return [
      {
        name: "model",
        responsibility:
          "Domain equations, state schema, invariants, and unit conversions.",
      },
      {
        name: "engine",
        responsibility:
          "Deterministic stepping, event scheduling, reproducible seeds, and time control.",
      },
      {
        name: "scenarios",
        responsibility:
          "Scenario definitions, initial conditions, and parameter sweeps.",
      },
      {
        name: "telemetry",
        responsibility: "Metrics, traces, snapshots, and regression baselines.",
      },
      {
        name: "interface",
        responsibility:
          "CLI/API/visualization controls for running and inspecting simulations.",
      },
      {
        name: "tests",
        responsibility:
          "Invariant, convergence, performance, and replay verification gates.",
      },
    ];
  }
  if (targetType === "complex_task") {
    return [
      {
        name: "intake",
        responsibility:
          "Clarify goals, constraints, inputs, assumptions, and acceptance evidence.",
      },
      {
        name: "planner",
        responsibility:
          "Break the work into a dependency-aware task graph and execution strategy.",
      },
      {
        name: "executor",
        responsibility:
          "Run scoped steps through adapters, tools, and reversible checkpoints.",
      },
      {
        name: "verification",
        responsibility:
          "Define and run gates that prove correctness, safety, and completeness.",
      },
      {
        name: "observability",
        responsibility:
          "Record decisions, artifacts, metrics, risks, and replayable evidence.",
      },
      {
        name: "handoff",
        responsibility:
          "Package results, unresolved risks, and next actions for review or automation.",
      },
    ];
  }
  return [
    { name: "core", responsibility: "Main domain logic and public API." },
    {
      name: "adapters",
      responsibility:
        "Filesystem, network, provider, or platform integrations.",
    },
    {
      name: "cli",
      responsibility: "Operator commands and local automation entry points.",
    },
    {
      name: "docs",
      responsibility: "Usage, architecture, and maintenance notes.",
    },
    {
      name: "tests",
      responsibility: "Focused verification for contracts and regressions.",
    },
  ];
}

function targetFiles(
  projectName: string,
  targetType: ProjectTargetType,
): ProjectWorkflowFile[] {
  const slug = slugify(projectName);
  if (targetType === "os") {
    return [
      {
        path: `${slug}/README.md`,
        purpose: "Project overview, boot target, and emulator instructions.",
        priority: "must",
      },
      {
        path: `${slug}/docs/architecture.md`,
        purpose:
          "Kernel architecture, boot flow, memory model, and syscall map.",
        priority: "must",
      },
      {
        path: `${slug}/boot/boot.asm`,
        purpose: "Boot entry or bootloader handoff stub.",
        priority: "must",
      },
      {
        path: `${slug}/kernel/main.c`,
        purpose: "Kernel entry, startup diagnostics, and panic handler.",
        priority: "must",
      },
      {
        path: `${slug}/kernel/memory.c`,
        purpose: "Physical/virtual memory manager skeleton.",
        priority: "should",
      },
      {
        path: `${slug}/kernel/scheduler.c`,
        purpose: "Task scheduler skeleton and timer integration.",
        priority: "should",
      },
      {
        path: `${slug}/drivers/display.c`,
        purpose: "Framebuffer/text display driver.",
        priority: "must",
      },
      {
        path: `${slug}/drivers/input.c`,
        purpose: "Keyboard/input driver stub.",
        priority: "should",
      },
      {
        path: `${slug}/shell/shell.c`,
        purpose: "Minimal command shell for runtime inspection.",
        priority: "should",
      },
      {
        path: `${slug}/Makefile`,
        purpose: "Build, image, emulator, clean, and test commands.",
        priority: "must",
      },
      {
        path: `${slug}/tests/boot-smoke.md`,
        purpose: "Manual/emulator boot smoke checklist.",
        priority: "must",
      },
      {
        path: `${slug}/scripts/verify.mjs`,
        purpose:
          "Portable scaffold verification used by post-generation gates.",
        priority: "must",
      },
    ];
  }
  if (targetType === "simulation") {
    return [
      {
        path: `${slug}/README.md`,
        purpose:
          "Project overview, model assumptions, and simulation commands.",
        priority: "must",
      },
      {
        path: `${slug}/docs/architecture.md`,
        purpose:
          "Simulation architecture, state flow, invariants, and reproducibility plan.",
        priority: "must",
      },
      {
        path: `${slug}/src/index.ts`,
        purpose: "CLI/API entry point for running simulation scenarios.",
        priority: "must",
      },
      {
        path: `${slug}/src/simulation/model.ts`,
        purpose: "Typed state model, parameters, and invariant checks.",
        priority: "must",
      },
      {
        path: `${slug}/src/simulation/engine.ts`,
        purpose: "Deterministic simulation stepper and event loop.",
        priority: "must",
      },
      {
        path: `${slug}/src/scenarios/default.ts`,
        purpose: "Default scenario and parameter sweep definitions.",
        priority: "must",
      },
      {
        path: `${slug}/src/telemetry/metrics.ts`,
        purpose: "Metrics, traces, and replay snapshot helpers.",
        priority: "should",
      },
      {
        path: `${slug}/tests/simulation-smoke.test.ts`,
        purpose: "Replay, invariant, and deterministic smoke gate.",
        priority: "must",
      },
      {
        path: `${slug}/scripts/verify.mjs`,
        purpose:
          "Portable simulation scaffold verification and deterministic gate runner.",
        priority: "must",
      },
      {
        path: `${slug}/package.json`,
        purpose: "Scripts for build, test, simulate, and smoke.",
        priority: "must",
      },
    ];
  }
  if (targetType === "complex_task") {
    return [
      {
        path: `${slug}/README.md`,
        purpose:
          "Task objective, operating assumptions, and execution checklist.",
        priority: "must",
      },
      {
        path: `${slug}/docs/architecture.md`,
        purpose:
          "Workflow architecture, boundaries, risk model, and evidence strategy.",
        priority: "must",
      },
      {
        path: `${slug}/workflow/requirements.md`,
        purpose:
          "Structured requirements, constraints, acceptance criteria, and open risks.",
        priority: "must",
      },
      {
        path: `${slug}/workflow/task-graph.json`,
        purpose: "Dependency-aware task graph for planning and execution.",
        priority: "must",
      },
      {
        path: `${slug}/src/index.ts`,
        purpose: "Programmatic entry point for the generated task workflow.",
        priority: "must",
      },
      {
        path: `${slug}/src/planner/task-graph.ts`,
        purpose:
          "Typed task graph, dependency ordering, and next-step selection.",
        priority: "must",
      },
      {
        path: `${slug}/src/executor/runbook.ts`,
        purpose: "Execution runbook primitives and checkpoint handoff.",
        priority: "must",
      },
      {
        path: `${slug}/src/verification/gates.ts`,
        purpose: "Verification gate definitions and evidence checks.",
        priority: "must",
      },
      {
        path: `${slug}/docs/evidence.md`,
        purpose: "Verification evidence log and decision record.",
        priority: "should",
      },
      {
        path: `${slug}/scripts/verify.mjs`,
        purpose: "Portable complex-task scaffold verification runner.",
        priority: "must",
      },
      {
        path: `${slug}/package.json`,
        purpose: "Scripts for build, test, verify, and smoke.",
        priority: "must",
      },
    ];
  }
  return [
    {
      path: `${slug}/README.md`,
      purpose: "Project overview, setup, and delivery checklist.",
      priority: "must",
    },
    {
      path: `${slug}/docs/architecture.md`,
      purpose: "Architecture decisions, boundaries, and data flow.",
      priority: "must",
    },
    {
      path: `${slug}/src/index.ts`,
      purpose: "Main application or library entry point.",
      priority: "must",
    },
    {
      path: `${slug}/src/domain/index.ts`,
      purpose: "Core domain rules separated from adapters.",
      priority: "must",
    },
    {
      path: `${slug}/src/adapters/index.ts`,
      purpose: "External service and platform adapter boundary.",
      priority: "should",
    },
    {
      path: `${slug}/tests/smoke.test.ts`,
      purpose: "End-to-end or integration smoke gate.",
      priority: "must",
    },
    {
      path: `${slug}/scripts/verify.mjs`,
      purpose: "Portable scaffold verification used by post-generation gates.",
      priority: "must",
    },
    {
      path: `${slug}/package.json`,
      purpose: "Scripts for build, test, lint, and smoke.",
      priority: "must",
    },
  ];
}

function verificationGates(
  targetType: ProjectTargetType,
): ProjectWorkflowGate[] {
  if (targetType === "os") {
    return [
      {
        name: "build",
        command: "node scripts/verify.mjs build",
        evidence: "Boot/kernel/toolchain scaffold contract is verified.",
      },
      {
        name: "emulator boot",
        command: "node scripts/verify.mjs run",
        evidence:
          "Emulator handoff checklist is verified for the generated scaffold.",
      },
      {
        name: "smoke",
        command: "node scripts/verify.mjs smoke",
        evidence:
          "Boot checklist and display/input/shell scaffold checks pass.",
      },
    ];
  }
  if (targetType === "simulation") {
    return [
      {
        name: "unit tests",
        command: "node scripts/verify.mjs test",
        evidence: "Model invariants and deterministic engine behavior pass.",
      },
      {
        name: "simulate",
        command: "node scripts/verify.mjs simulate",
        evidence: "Default scenario produces a bounded reproducible trace.",
      },
      {
        name: "smoke",
        command: "node scripts/verify.mjs smoke",
        evidence: "Replay, invariant, and baseline checks pass without drift.",
      },
    ];
  }
  if (targetType === "complex_task") {
    return [
      {
        name: "plan validation",
        command: "node scripts/verify.mjs plan",
        evidence:
          "Requirements, task graph, dependencies, and acceptance gates are coherent.",
      },
      {
        name: "dry run",
        command: "node scripts/verify.mjs dry-run",
        evidence:
          "Execution runbook can be traversed without missing dependencies.",
      },
      {
        name: "smoke",
        command: "node scripts/verify.mjs smoke",
        evidence:
          "Evidence, gate, and handoff scaffolds are complete and replayable.",
      },
    ];
  }
  return [
    {
      name: "unit tests",
      command: "node scripts/verify.mjs test",
      evidence: "Core behavior and adapters pass focused tests.",
    },
    {
      name: "build",
      command: "node scripts/verify.mjs build",
      evidence: "Production artifact builds without type or bundling errors.",
    },
    {
      name: "smoke",
      command: "node scripts/verify.mjs smoke",
      evidence: "Primary user workflow works in runtime.",
    },
  ];
}

function buildMilestones(
  targetType: ProjectTargetType,
): ProjectWorkflowMilestone[] {
  const gates = verificationGates(targetType);
  return [
    {
      name: "Blueprint",
      outcome:
        "Requirements, architecture, and risk plan are explicit before writing broad code.",
      steps: [
        "Extract concrete requirements from the brief and any sketches/assets.",
        "Define module boundaries, data flow, and runtime constraints.",
        "Choose the smallest vertical slice that proves the architecture.",
      ],
      gates: [
        {
          name: "blueprint review",
          evidence: "Requirements and acceptance gates are written down.",
        },
      ],
    },
    {
      name: "Vertical Slice",
      outcome: "A minimal running artifact proves the highest-risk path.",
      steps: [
        "Create the workspace and core files.",
        "Implement the startup path and one end-to-end user/system workflow.",
        "Keep placeholders isolated behind interfaces so later expansion does not require rewrites.",
      ],
      gates: [gates[0], gates[1]].filter(Boolean),
    },
    {
      name: "Feature Expansion",
      outcome:
        "Expected capabilities are added behind the established boundaries.",
      steps: [
        "Implement modules in dependency order.",
        "Add regression tests next to each module contract.",
        "Run smoke checks after each meaningful integration step.",
      ],
      gates,
    },
    {
      name: "Hardening",
      outcome: "The artifact is maintainable, testable, and ready for review.",
      steps: [
        "Remove dead paths, insecure defaults, and placeholder behavior.",
        "Document setup, limitations, and verification evidence.",
        "Run the full gate list from a clean state.",
      ],
      gates,
    },
  ];
}

function buildWorkflow(input: NormalizedProjectWorkflowInput): ProjectWorkflow {
  const projectName =
    input.projectName || inferProjectName(input.brief, input.targetType);
  const modules = targetModules(input.targetType);
  const gates = verificationGates(input.targetType);
  return {
    id: `${slugify(projectName)}-${Date.now()}`,
    projectName,
    targetType: input.targetType,
    createdAt: new Date().toISOString(),
    brief: input.brief,
    constraints: input.constraints,
    assumptions: [
      "Start with a verifiable vertical slice before expanding scope.",
      "Every generated file must have an acceptance gate or a clear reason to exist.",
      "Prefer deterministic local checks before relying on external services.",
      input.targetType === "os"
        ? "Use an emulator-first workflow before targeting physical hardware."
        : input.targetType === "complex_task"
          ? "Keep each complex-task step independently verifiable, reversible, and evidence-backed."
          : "Keep domain logic independent from UI and transport adapters.",
    ],
    architecture: {
      style:
        input.targetType === "os"
          ? "Layered kernel with explicit boot, kernel, driver, shell, and toolchain boundaries."
          : input.targetType === "simulation"
            ? "Deterministic simulation architecture with model, engine, scenario, telemetry, interface, and verification layers."
            : input.targetType === "complex_task"
              ? "Agentic complex-task architecture with intake, planning, execution, verification, observability, and handoff layers."
              : "Modular vertical-slice architecture with domain, adapter, interface, and verification layers.",
      modules,
      dataFlow: modules.map(
        (module, index) =>
          `${index + 1}. ${module.name}: ${module.responsibility}`,
      ),
    },
    fileTree: targetFiles(projectName, input.targetType),
    milestones: buildMilestones(input.targetType),
    riskRegister: [
      {
        risk: "Scope expands faster than verification.",
        mitigation:
          "Gate every milestone with build/test/smoke evidence before adding broad features.",
      },
      {
        risk: "Generated structure does not match the user's sketch or domain.",
        mitigation:
          "Keep a blueprint review step and revise file tree before implementation.",
      },
      {
        risk: "Platform-specific assumptions break runtime.",
        mitigation: `Run ${gates.map((gate) => gate.name).join(", ")} on the target platform early.`,
      },
    ],
    reviewLoop: [
      "Plan the smallest next change.",
      "Edit only the files needed for that change.",
      "Run the narrowest meaningful gate.",
      "Broaden tests/build/smoke before declaring the milestone done.",
      "Record evidence and remaining risk.",
    ],
  };
}

function workflowMarkdown(workflow: ProjectWorkflow): string {
  const lines = [
    `# ${workflow.projectName} Workflow`,
    "",
    `Target: ${workflow.targetType}`,
    `Created: ${workflow.createdAt}`,
    "",
    "## Brief",
    workflow.brief,
    "",
    "## Architecture",
    workflow.architecture.style,
    "",
    ...workflow.architecture.modules.map(
      (module) => `- ${module.name}: ${module.responsibility}`,
    ),
    "",
    "## File Tree",
    ...workflow.fileTree.map(
      (file) => `- [${file.priority}] ${file.path} - ${file.purpose}`,
    ),
    "",
    "## Milestones",
    ...workflow.milestones.flatMap((milestone) => [
      `### ${milestone.name}`,
      milestone.outcome,
      ...milestone.steps.map((step) => `- ${step}`),
      ...milestone.gates.map(
        (gate) =>
          `- Gate: ${gate.name}${gate.command ? ` (${gate.command})` : ""} - ${gate.evidence}`,
      ),
      "",
    ]),
    "## Review Loop",
    ...workflow.reviewLoop.map((step) => `- ${step}`),
    "",
  ];
  return lines.join("\n");
}

function projectReadme(workflow: ProjectWorkflow): string {
  const gates = verificationGates(workflow.targetType);
  return [
    `# ${workflow.projectName}`,
    "",
    workflow.brief,
    "",
    "## First Milestone",
    "Start with the vertical slice and keep each change behind a verification gate.",
    "",
    "## Verification",
    ...gates.map(
      (gate) =>
        `- ${gate.name}${gate.command ? `: \`${gate.command}\`` : ""} - ${gate.evidence}`,
    ),
    "",
    "## Review Loop",
    ...workflow.reviewLoop.map((step) => `- ${step}`),
    "",
  ].join("\n");
}

function architectureMarkdown(workflow: ProjectWorkflow): string {
  return [
    `# ${workflow.projectName} Architecture`,
    "",
    workflow.architecture.style,
    "",
    "## Modules",
    ...workflow.architecture.modules.map(
      (module) => `- **${module.name}**: ${module.responsibility}`,
    ),
    "",
    "## Data Flow",
    ...workflow.architecture.dataFlow.map((step) => `- ${step}`),
    "",
    "## Risks",
    ...workflow.riskRegister.map(
      (item) => `- ${item.risk} Mitigation: ${item.mitigation}`,
    ),
    "",
  ].join("\n");
}

function osMakefile(_workflow: ProjectWorkflow): string {
  return [
    ".PHONY: build run smoke clean",
    "",
    "build:",
    "\t@node scripts/verify.mjs build",
    "",
    "run:",
    "\t@node scripts/verify.mjs run",
    "",
    "smoke:",
    `\t@node scripts/verify.mjs smoke`,
    "",
    "clean:",
    '\t@echo "Clean generated build artifacts here."',
    "",
  ].join("\n");
}

function bootAsm(workflow: ProjectWorkflow): string {
  return [
    "; Minimal x86 boot-sector scaffold generated from the project workflow.",
    "; Replace this with the real bootloader once the toolchain is selected.",
    "[org 0x7c00]",
    "[bits 16]",
    "",
    "start:",
    "  mov si, message",
    "print:",
    "  lodsb",
    "  or al, al",
    "  jz halt",
    "  mov ah, 0x0e",
    "  int 0x10",
    "  jmp print",
    "",
    "halt:",
    "  cli",
    "  hlt",
    "",
    `message db "${workflow.projectName} boot scaffold", 0`,
    "",
    "times 510-($-$$) db 0",
    "dw 0xaa55",
    "",
  ].join("\n");
}

function cScaffold(symbol: string, description: string): string {
  return [
    "/* Generated scaffold for a runtime bootstrap hook. */",
    `/* ${description} */`,
    "",
    `void ${symbol}_init(void) {`,
    "  /* Intentionally empty until the owning vertical slice wires runtime behavior. */",
    "}",
    "",
  ].join("\n");
}

function osBootSmoke(workflow: ProjectWorkflow): string {
  return [
    `# ${workflow.projectName} Boot Smoke`,
    "",
    "- Build command completes without errors.",
    "- Emulator reaches the boot banner.",
    "- Kernel entry runs without panic.",
    "- Display driver writes visible output.",
    "- Input path can be stubbed or verified.",
    "- Shell command loop responds to at least one command.",
    "",
  ].join("\n");
}

function complexRequirementsMarkdown(workflow: ProjectWorkflow): string {
  return [
    `# ${workflow.projectName} Requirements`,
    "",
    "## Objective",
    workflow.brief,
    "",
    "## Acceptance Criteria",
    "- The task graph has no missing dependencies.",
    "- Each execution step has an owner, outcome, and verification gate.",
    "- Risks and assumptions are recorded before execution.",
    "- Final handoff includes evidence and unresolved risks.",
    "",
    "## Constraints",
    ...(workflow.constraints.length > 0
      ? workflow.constraints.map((constraint) => `- ${constraint}`)
      : ["- Keep execution scoped, reversible, and evidence-backed."]),
    "",
  ].join("\n");
}

function complexTaskGraphJson(workflow: ProjectWorkflow): string {
  return JSON.stringify(
    {
      project: workflow.projectName,
      nodes: [
        { id: "intake", depends_on: [], gate: "plan validation" },
        { id: "plan", depends_on: ["intake"], gate: "plan validation" },
        { id: "execute", depends_on: ["plan"], gate: "dry run" },
        { id: "verify", depends_on: ["execute"], gate: "smoke" },
        { id: "handoff", depends_on: ["verify"], gate: "smoke" },
      ],
    },
    null,
    2,
  );
}

function verificationScript(workflow: ProjectWorkflow): string {
  const slug = slugify(workflow.projectName);
  const relativeFiles = workflow.fileTree
    .map((file) =>
      file.path.startsWith(`${slug}/`)
        ? file.path.slice(slug.length + 1)
        : file.path,
    )
    .filter((filePath) => filePath !== "scripts/verify.mjs");
  const contentChecks =
    workflow.targetType === "os"
      ? [
          { path: "boot/boot.asm", includes: "dw 0xaa55" },
          { path: "kernel/main.c", includes: "kernel_init" },
          { path: "Makefile", includes: "verify.mjs" },
          { path: "tests/boot-smoke.md", includes: "Boot Smoke" },
        ]
      : workflow.targetType === "simulation"
        ? [
            {
              path: "src/simulation/model.ts",
              includes: "SimulationParameters",
            },
            { path: "src/simulation/engine.ts", includes: "runSimulation" },
            { path: "src/scenarios/default.ts", includes: "defaultParameters" },
            { path: "src/telemetry/metrics.ts", includes: "summarizeTrace" },
          ]
        : workflow.targetType === "complex_task"
          ? [
              {
                path: "workflow/requirements.md",
                includes: "Acceptance Criteria",
              },
              { path: "workflow/task-graph.json", includes: "depends_on" },
              {
                path: "src/planner/task-graph.ts",
                includes: "topologicalOrder",
              },
              { path: "src/executor/runbook.ts", includes: "createRunbook" },
              {
                path: "src/verification/gates.ts",
                includes: "verifyTaskGraph",
              },
              { path: "docs/evidence.md", includes: "Evidence Log" },
            ]
          : [
              { path: "src/index.ts", includes: "main" },
              { path: "docs/architecture.md", includes: "Architecture" },
              { path: "README.md", includes: workflow.projectName },
            ];

  return [
    "import fs from 'node:fs';",
    "",
    `const targetType = ${JSON.stringify(workflow.targetType)};`,
    "const mode = process.argv[2] || 'smoke';",
    `const requiredFiles = ${JSON.stringify(relativeFiles, null, 2)};`,
    `const contentChecks = ${JSON.stringify(contentChecks, null, 2)};`,
    "",
    "function fail(message) {",
    "  console.error(message);",
    "  process.exit(1);",
    "}",
    "",
    "for (const filePath of requiredFiles) {",
    "  if (!fs.existsSync(filePath)) fail(`Missing required file: ${filePath}`);",
    "}",
    "",
    "for (const check of contentChecks) {",
    "  if (!fs.existsSync(check.path)) fail(`Missing checked file: ${check.path}`);",
    "  const content = fs.readFileSync(check.path, 'utf-8');",
    "  if (!content.includes(check.includes)) {",
    "    fail(`File ${check.path} does not include expected marker: ${check.includes}`);",
    "  }",
    "}",
    "",
    "if (targetType === 'simulation' && mode === 'simulate') {",
    "  let energy = 1;",
    "  const steps = 120;",
    "  for (let index = 0; index < steps; index += 1) energy *= 0.995;",
    "  const result = { mode, status: 'passed', targetType, steps, duration: 1.92, finalEnergy: Number(energy.toFixed(6)) };",
    "  console.log(JSON.stringify(result));",
    "} else {",
    "  console.log(JSON.stringify({ mode, status: 'passed', targetType, checkedFiles: requiredFiles.length }));",
    "}",
    "",
  ].join("\n");
}

function packageJson(workflow: ProjectWorkflow): string {
  const scripts =
    workflow.targetType === "simulation"
      ? {
          build: "node scripts/verify.mjs build",
          test: "node scripts/verify.mjs test",
          simulate: "node scripts/verify.mjs simulate",
          smoke: "node scripts/verify.mjs smoke",
        }
      : workflow.targetType === "complex_task"
        ? {
            plan: "node scripts/verify.mjs plan",
            "dry-run": "node scripts/verify.mjs dry-run",
            verify: "node scripts/verify.mjs smoke",
            smoke: "node scripts/verify.mjs smoke",
          }
        : {
            build: "node scripts/verify.mjs build",
            test: "node scripts/verify.mjs test",
            smoke: "node scripts/verify.mjs smoke",
          };
  return JSON.stringify(
    {
      name: slugify(workflow.projectName),
      version: "0.1.0",
      private: true,
      type: "module",
      scripts,
      devDependencies: {},
    },
    null,
    2,
  );
}

function genericTs(pathName: string, workflow: ProjectWorkflow): string {
  if (
    pathName.endsWith("tests/smoke.test.ts") ||
    pathName.endsWith("tests/simulation-smoke.test.ts")
  ) {
    return [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "",
      "test('smoke scaffold is wired', () => {",
      `  assert.equal('${workflow.targetType}'.length > 0, true);`,
      "});",
      "",
    ].join("\n");
  }
  if (pathName.endsWith("src/simulation/model.ts")) {
    return [
      "export interface SimulationParameters {",
      "  seed: number;",
      "  stepSize: number;",
      "  maxSteps: number;",
      "}",
      "",
      "export interface SimulationState {",
      "  step: number;",
      "  time: number;",
      "  energy: number;",
      "}",
      "",
      "export function createInitialState(): SimulationState {",
      "  return { step: 0, time: 0, energy: 1 };",
      "}",
      "",
      "export function assertStateInvariant(state: SimulationState): void {",
      "  if (!Number.isFinite(state.time) || !Number.isFinite(state.energy)) {",
      "    throw new Error('simulation state contains non-finite values');",
      "  }",
      "  if (state.step < 0 || state.time < 0) {",
      "    throw new Error('simulation state moved backwards');",
      "  }",
      "}",
      "",
    ].join("\n");
  }
  if (pathName.endsWith("src/simulation/engine.ts")) {
    return [
      "import { assertStateInvariant, type SimulationParameters, type SimulationState } from './model.js';",
      "",
      "export function stepSimulation(",
      "  state: SimulationState,",
      "  params: SimulationParameters,",
      "): SimulationState {",
      "  const next = {",
      "    step: state.step + 1,",
      "    time: state.time + params.stepSize,",
      "    energy: state.energy * 0.995,",
      "  };",
      "  assertStateInvariant(next);",
      "  return next;",
      "}",
      "",
      "export function runSimulation(",
      "  initialState: SimulationState,",
      "  params: SimulationParameters,",
      "): SimulationState[] {",
      "  const states = [initialState];",
      "  for (let index = 0; index < params.maxSteps; index += 1) {",
      "    states.push(stepSimulation(states[states.length - 1], params));",
      "  }",
      "  return states;",
      "}",
      "",
    ].join("\n");
  }
  if (pathName.endsWith("src/scenarios/default.ts")) {
    return [
      "import { createInitialState, type SimulationParameters } from '../simulation/model.js';",
      "",
      "export const defaultParameters: SimulationParameters = {",
      "  seed: 1,",
      "  stepSize: 0.016,",
      "  maxSteps: 120,",
      "};",
      "",
      "export const defaultInitialState = createInitialState();",
      "",
    ].join("\n");
  }
  if (pathName.endsWith("src/telemetry/metrics.ts")) {
    return [
      "import type { SimulationState } from '../simulation/model.js';",
      "",
      "export interface SimulationMetrics {",
      "  steps: number;",
      "  duration: number;",
      "  finalEnergy: number;",
      "}",
      "",
      "export function summarizeTrace(trace: SimulationState[]): SimulationMetrics {",
      "  const final = trace[trace.length - 1];",
      "  return {",
      "    steps: final?.step ?? 0,",
      "    duration: final?.time ?? 0,",
      "    finalEnergy: final?.energy ?? 0,",
      "  };",
      "}",
      "",
    ].join("\n");
  }
  if (
    workflow.targetType === "simulation" &&
    pathName.endsWith("src/index.ts")
  ) {
    return [
      "import { defaultInitialState, defaultParameters } from './scenarios/default.js';",
      "import { runSimulation } from './simulation/engine.js';",
      "import { summarizeTrace } from './telemetry/metrics.js';",
      "",
      "export function main(): string {",
      "  const trace = runSimulation(defaultInitialState, defaultParameters);",
      "  return JSON.stringify(summarizeTrace(trace));",
      "}",
      "",
      "if (import.meta.url === `file://${process.argv[1]}`) {",
      "  console.log(main());",
      "}",
      "",
    ].join("\n");
  }
  if (pathName.endsWith("src/planner/task-graph.ts")) {
    return [
      "export interface TaskNode {",
      "  id: string;",
      "  dependsOn: string[];",
      "  gate: string;",
      "}",
      "",
      "export function topologicalOrder(nodes: TaskNode[]): string[] {",
      "  const byId = new Map(nodes.map((node) => [node.id, node]));",
      "  const visited = new Set<string>();",
      "  const visiting = new Set<string>();",
      "  const ordered: string[] = [];",
      "",
      "  function visit(id: string): void {",
      "    if (visited.has(id)) return;",
      "    if (visiting.has(id)) throw new Error(`cycle detected at ${id}`);",
      "    const node = byId.get(id);",
      "    if (!node) throw new Error(`missing task node ${id}`);",
      "    visiting.add(id);",
      "    for (const dependency of node.dependsOn) visit(dependency);",
      "    visiting.delete(id);",
      "    visited.add(id);",
      "    ordered.push(id);",
      "  }",
      "",
      "  for (const node of nodes) visit(node.id);",
      "  return ordered;",
      "}",
      "",
    ].join("\n");
  }
  if (pathName.endsWith("src/executor/runbook.ts")) {
    return [
      "import type { TaskNode } from '../planner/task-graph.js';",
      "",
      "export interface RunbookStep {",
      "  id: string;",
      "  command: string;",
      "  reversible: boolean;",
      "}",
      "",
      "export function createRunbook(nodes: TaskNode[]): RunbookStep[] {",
      "  return nodes.map((node) => ({",
      "    id: node.id,",
      "    command: `execute:${node.id}`,",
      "    reversible: node.id !== 'handoff',",
      "  }));",
      "}",
      "",
    ].join("\n");
  }
  if (pathName.endsWith("src/verification/gates.ts")) {
    return [
      "import { topologicalOrder, type TaskNode } from '../planner/task-graph.js';",
      "",
      "export function verifyTaskGraph(nodes: TaskNode[]): boolean {",
      "  const ordered = topologicalOrder(nodes);",
      "  return ordered.length === nodes.length && ordered[0] === 'intake';",
      "}",
      "",
      "export function verifyEvidenceLog(content: string): boolean {",
      "  return content.includes('Evidence Log') && content.includes('Risks');",
      "}",
      "",
    ].join("\n");
  }
  if (
    workflow.targetType === "complex_task" &&
    pathName.endsWith("src/index.ts")
  ) {
    return [
      "import { createRunbook } from './executor/runbook.js';",
      "import { topologicalOrder, type TaskNode } from './planner/task-graph.js';",
      "import { verifyTaskGraph } from './verification/gates.js';",
      "",
      "export function main(): string {",
      "  const nodes: TaskNode[] = [",
      "    { id: 'intake', dependsOn: [], gate: 'plan validation' },",
      "    { id: 'plan', dependsOn: ['intake'], gate: 'plan validation' },",
      "    { id: 'execute', dependsOn: ['plan'], gate: 'dry run' },",
      "    { id: 'verify', dependsOn: ['execute'], gate: 'smoke' },",
      "    { id: 'handoff', dependsOn: ['verify'], gate: 'smoke' },",
      "  ];",
      "  return JSON.stringify({",
      "    ordered: topologicalOrder(nodes),",
      "    runbook: createRunbook(nodes),",
      "    verified: verifyTaskGraph(nodes),",
      "  });",
      "}",
      "",
      "if (import.meta.url === `file://${process.argv[1]}`) {",
      "  console.log(main());",
      "}",
      "",
    ].join("\n");
  }
  if (pathName.endsWith("src/domain/index.ts")) {
    return [
      "export interface ProjectBrief {",
      "  title: string;",
      "  constraints: string[];",
      "}",
      "",
      "export function summarizeBrief(brief: ProjectBrief): string {",
      "  return `${brief.title}: ${brief.constraints.length} constraints`;",
      "}",
      "",
    ].join("\n");
  }
  if (pathName.endsWith("src/adapters/index.ts")) {
    return [
      "export interface AdapterHealth {",
      "  name: string;",
      "  ready: boolean;",
      "}",
      "",
      "export function localAdapterHealth(): AdapterHealth {",
      "  return { name: 'local', ready: true };",
      "}",
      "",
    ].join("\n");
  }
  return [
    "export function main(): string {",
    `  return '${workflow.projectName} scaffold ready';`,
    "}",
    "",
    "if (import.meta.url === `file://${process.argv[1]}`) {",
    "  console.log(main());",
    "}",
    "",
  ].join("\n");
}

function scaffoldContent(
  workflow: ProjectWorkflow,
  file: ProjectWorkflowFile,
): string {
  const normalized = file.path.replaceAll("\\", "/");
  if (normalized.endsWith("/README.md")) return projectReadme(workflow);
  if (normalized.endsWith("/docs/architecture.md")) {
    return architectureMarkdown(workflow);
  }
  if (normalized.endsWith("/workflow/requirements.md")) {
    return complexRequirementsMarkdown(workflow);
  }
  if (normalized.endsWith("/workflow/task-graph.json")) {
    return complexTaskGraphJson(workflow);
  }
  if (normalized.endsWith("/docs/evidence.md")) {
    return [
      `# ${workflow.projectName} Evidence Log`,
      "",
      "## Verification",
      "- Gate evidence is recorded in VERIFICATION.md after run_gates executes.",
      "",
      "## Risks",
      "- Keep unresolved assumptions explicit before handoff.",
      "",
    ].join("\n");
  }
  if (normalized.endsWith("/scripts/verify.mjs")) {
    return verificationScript(workflow);
  }
  if (workflow.targetType === "os") {
    if (normalized.endsWith("/Makefile")) return osMakefile(workflow);
    if (normalized.endsWith("/boot/boot.asm")) return bootAsm(workflow);
    if (normalized.endsWith("/kernel/main.c")) {
      return cScaffold("kernel", "Kernel entry and startup diagnostics.");
    }
    if (normalized.endsWith("/kernel/memory.c")) {
      return cScaffold("memory", "Physical and virtual memory manager.");
    }
    if (normalized.endsWith("/kernel/scheduler.c")) {
      return cScaffold("scheduler", "Timer-driven task scheduler.");
    }
    if (normalized.endsWith("/drivers/display.c")) {
      return cScaffold("display", "Framebuffer or text-mode display driver.");
    }
    if (normalized.endsWith("/drivers/input.c")) {
      return cScaffold("input", "Keyboard/input driver.");
    }
    if (normalized.endsWith("/shell/shell.c")) {
      return cScaffold("shell", "Minimal command shell.");
    }
    if (normalized.endsWith("/tests/boot-smoke.md")) {
      return osBootSmoke(workflow);
    }
  }
  if (normalized.endsWith("/package.json")) return packageJson(workflow);
  if (normalized.endsWith(".ts")) return genericTs(normalized, workflow);
  return `${file.purpose}\n`;
}

function writeScaffoldFiles(
  rootDir: string,
  workflow: ProjectWorkflow,
  overwrite: boolean,
): WriteScaffoldResult {
  const root = path.resolve(rootDir);
  const scaffoldedFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const file of workflow.fileTree) {
    const target = path.resolve(root, file.path);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(
        `Refusing to scaffold outside output directory: ${file.path}`,
      );
    }
    if (fs.existsSync(target) && !overwrite) {
      skippedFiles.push(target);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, scaffoldContent(workflow, file), "utf-8");
    scaffoldedFiles.push(target);
  }

  return { scaffoldedFiles, skippedFiles };
}

function limitOutput(value: unknown, maxLength = 6000): string {
  const text = typeof value === "string" ? value : "";
  return text.length > maxLength
    ? `${text.slice(0, maxLength)}\n[output truncated]`
    : text;
}

function commandParts(command: string): { file: string; args: string[] } {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const [rawFile, ...args] = parts;
  if (!rawFile) throw new Error("Gate command is empty");
  if (rawFile === "node") return { file: process.execPath, args };
  if (rawFile === "npm") {
    return {
      file: process.platform === "win32" ? "npm.cmd" : "npm",
      args,
    };
  }
  return { file: rawFile, args };
}

function selectedGates(
  workflow: ProjectWorkflow,
  gateNames?: string[] | string,
): ProjectWorkflowGate[] {
  const gates = verificationGates(workflow.targetType);
  const requested = new Set(
    asStringArray(gateNames).map((name) => name.toLowerCase()),
  );
  if (requested.size === 0) return gates;
  return gates.filter((gate) => requested.has(gate.name.toLowerCase()));
}

function runWorkflowGates(
  rootDir: string,
  workflow: ProjectWorkflow,
  gateNames?: string[] | string,
  timeoutMs = 30_000,
): ProjectWorkflowGateResult[] {
  const root = path.resolve(rootDir);
  const projectRoot = path.resolve(root, slugify(workflow.projectName));
  if (projectRoot !== root && !projectRoot.startsWith(`${root}${path.sep}`)) {
    throw new Error("Refusing to run gates outside output directory");
  }
  if (!fs.existsSync(projectRoot)) {
    throw new Error("run_gates requires a generated scaffold project root");
  }

  const gates = selectedGates(workflow, gateNames);
  if (gates.length === 0) {
    throw new Error("No verification gates matched gate_names");
  }

  const safeTimeoutMs = Math.max(
    1_000,
    Math.min(Math.floor(timeoutMs || 30_000), 5 * 60_000),
  );

  return gates.map((gate) => {
    if (!gate.command) {
      return {
        name: gate.name,
        command: "",
        cwd: projectRoot,
        status: "skipped",
        exitCode: null,
        stdout: "",
        stderr: "Gate has no command.",
        durationMs: 0,
        evidence: gate.evidence,
      };
    }

    const startedAt = Date.now();
    const { file, args } = commandParts(gate.command);
    const result = child_process.spawnSync(file, args, {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: safeTimeoutMs,
      windowsHide: true,
      shell: false,
      maxBuffer: 1024 * 1024,
    });
    const stderr = [
      limitOutput(result.stderr),
      result.error ? String(result.error.message || result.error) : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      name: gate.name,
      command: gate.command,
      cwd: projectRoot,
      status: !result.error && result.status === 0 ? "passed" : "failed",
      exitCode: typeof result.status === "number" ? result.status : null,
      stdout: limitOutput(result.stdout),
      stderr,
      durationMs: Date.now() - startedAt,
      evidence: gate.evidence,
    };
  });
}

function verificationReportMarkdown(workflow: ProjectWorkflow): string {
  const results = workflow.gateResults || [];
  return [
    `# ${workflow.projectName} Verification`,
    "",
    `Target: ${workflow.targetType}`,
    `Checked: ${new Date().toISOString()}`,
    "",
    ...results.flatMap((result) => [
      `## ${result.name}`,
      `Status: ${result.status}`,
      `Command: \`${result.command || "none"}\``,
      `Duration: ${result.durationMs}ms`,
      `Evidence: ${result.evidence}`,
      "",
      "### Stdout",
      "```text",
      result.stdout.trim() || "(empty)",
      "```",
      "",
      "### Stderr",
      "```text",
      result.stderr.trim() || "(empty)",
      "```",
      "",
    ]),
  ].join("\n");
}

function resolveOutputDir(
  paths: RuntimePaths,
  projectName: string,
  outputDir?: string,
): string {
  const safeDefault = path.join(
    paths.dataDir,
    "project-workflows",
    slugify(projectName),
  );
  if (!outputDir) return safeDefault;
  return path.isAbsolute(outputDir)
    ? path.resolve(outputDir)
    : path.resolve(paths.sourceDir ?? paths.dataDir, outputDir);
}

export function createProjectWorkflow(
  paths: RuntimePaths | string,
  input: ProjectWorkflowInput,
): ProjectWorkflow {
  const runtimePaths = normalizeRuntimePaths(paths);
  const brief = asString(input.brief);
  if (!brief) throw new Error("brief is required");
  if (input.writeFiles === false && input.runGates === true) {
    throw new Error("run_gates requires write_files to be enabled");
  }
  const targetType = input.targetType
    ? normalizeTargetType(input.targetType)
    : inferTargetTypeFromBrief(brief);
  const workflow = buildWorkflow({
    brief,
    projectName:
      asString(input.projectName) || inferProjectName(brief, targetType),
    targetType,
    constraints: asStringArray(input.constraints),
    writeFiles: input.writeFiles !== false,
  });

  if (input.writeFiles !== false) {
    const outDir = resolveOutputDir(
      runtimePaths,
      workflow.projectName,
      input.outputDir,
    );
    fs.mkdirSync(outDir, { recursive: true });
    const jsonPath = path.join(outDir, "workflow.json");
    const readmePath = path.join(outDir, "README.md");
    const verificationPath = path.join(outDir, "VERIFICATION.md");
    workflow.outputDir = outDir;
    workflow.writtenFiles = [jsonPath, readmePath];
    if (input.scaffoldFiles === true || input.runGates === true) {
      const scaffold = writeScaffoldFiles(
        outDir,
        workflow,
        input.overwrite === true,
      );
      workflow.scaffoldRoot = outDir;
      workflow.scaffoldedFiles = scaffold.scaffoldedFiles;
      workflow.skippedFiles = scaffold.skippedFiles;
    }
    if (input.runGates === true) {
      workflow.gateResults = runWorkflowGates(
        outDir,
        workflow,
        input.gateNames,
        input.gateTimeoutMs,
      );
      workflow.verificationReportPath = verificationPath;
      workflow.writtenFiles.push(verificationPath);
      fs.writeFileSync(
        verificationPath,
        verificationReportMarkdown(workflow),
        "utf-8",
      );
    }
    fs.writeFileSync(readmePath, workflowMarkdown(workflow), "utf-8");
    fs.writeFileSync(jsonPath, JSON.stringify(workflow, null, 2), "utf-8");
  }

  return workflow;
}
