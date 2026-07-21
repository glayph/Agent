import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createProjectWorkflow } from "./project-workflow.js";
import { ToolRegistrySchemas } from "./registry/schemas.js";

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "project-workflow-test-"));
}

describe("project workflow generation", () => {
  test("creates an OS-style workflow with boot/kernel verification gates", () => {
    const workspace = tempWorkspace();

    const workflow = createProjectWorkflow(workspace, {
      brief:
        "Sketch OS: a tiny educational OS with display, keyboard, and shell",
      projectName: "Sketch OS",
      targetType: "os",
      constraints: ["emulator first", "low latency boot"],
    });

    expect(workflow.targetType).toBe("os");
    expect(workflow.architecture.modules.map((module) => module.name)).toEqual(
      expect.arrayContaining(["boot", "kernel", "drivers", "shell"]),
    );
    expect(workflow.fileTree.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "sketch-os/boot/boot.asm",
        "sketch-os/kernel/main.c",
        "sketch-os/Makefile",
      ]),
    );
    expect(
      workflow.milestones.flatMap((milestone) =>
        milestone.gates.map((gate) => gate.name),
      ),
    ).toEqual(expect.arrayContaining(["emulator boot", "smoke"]));
    expect(workflow.writtenFiles?.length).toBe(2);
    for (const file of workflow.writtenFiles || []) {
      expect(fs.existsSync(file)).toBe(true);
      expect(path.resolve(file).startsWith(path.resolve(workspace))).toBe(true);
    }
  });

  test("can return a workflow without writing artifacts", () => {
    const workspace = tempWorkspace();

    const workflow = createProjectWorkflow(workspace, {
      brief: "Build a dashboard for local agent runtime probes",
      targetType: "app",
      writeFiles: false,
    });

    expect(workflow.targetType).toBe("app");
    expect(workflow.writtenFiles).toBeUndefined();
    expect(fs.existsSync(path.join(workspace, "data"))).toBe(false);
  });

  test("creates a deterministic simulation workflow and scaffold", () => {
    const workspace = tempWorkspace();

    const workflow = createProjectWorkflow(workspace, {
      brief: "Build an orbital mechanics simulation with replayable scenarios",
      projectName: "Orbital Simulation",
      targetType: "simulation",
      outputDir: "generated/orbital-sim-workflow",
      scaffoldFiles: true,
    });

    const outputDir = path.join(workspace, "generated", "orbital-sim-workflow");
    const modelPath = path.join(
      outputDir,
      "orbital-simulation",
      "src",
      "simulation",
      "model.ts",
    );
    const enginePath = path.join(
      outputDir,
      "orbital-simulation",
      "src",
      "simulation",
      "engine.ts",
    );

    expect(workflow.targetType).toBe("simulation");
    expect(workflow.architecture.modules.map((module) => module.name)).toEqual(
      expect.arrayContaining(["model", "engine", "scenarios", "telemetry"]),
    );
    expect(
      workflow.milestones.flatMap((milestone) =>
        milestone.gates.map((gate) => gate.name),
      ),
    ).toEqual(expect.arrayContaining(["simulate", "smoke"]));
    expect(workflow.scaffoldedFiles).toEqual(
      expect.arrayContaining([modelPath, enginePath]),
    );
    expect(fs.readFileSync(modelPath, "utf-8")).toContain(
      "SimulationParameters",
    );
    expect(fs.readFileSync(enginePath, "utf-8")).toContain("runSimulation");
  });

  test("runs selected scaffold verification gates and persists evidence", () => {
    const workspace = tempWorkspace();

    const workflow = createProjectWorkflow(workspace, {
      brief: "Build a deterministic orbital simulation with replay gates",
      projectName: "Orbital Simulation",
      targetType: "simulation",
      outputDir: "generated/orbital-sim-workflow",
      runGates: true,
      gateNames: ["simulate", "smoke"],
      gateTimeoutMs: 10_000,
    });

    expect(workflow.scaffoldedFiles?.length).toBeGreaterThan(0);
    expect(workflow.gateResults?.map((result) => result.name)).toEqual([
      "simulate",
      "smoke",
    ]);
    expect(
      workflow.gateResults?.every((result) => result.status === "passed"),
    ).toBe(true);
    expect(workflow.gateResults?.[0]?.stdout).toContain("finalEnergy");
    expect(workflow.verificationReportPath).toBeDefined();
    expect(fs.existsSync(workflow.verificationReportPath || "")).toBe(true);

    const persistedWorkflow = JSON.parse(
      fs.readFileSync(
        path.join(
          workspace,
          "generated",
          "orbital-sim-workflow",
          "workflow.json",
        ),
        "utf-8",
      ),
    );
    expect(persistedWorkflow.gateResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "simulate", status: "passed" }),
        expect.objectContaining({ name: "smoke", status: "passed" }),
      ]),
    );
  });

  test("supports arbitrary complex tasks beyond named examples", () => {
    const workspace = tempWorkspace();

    const workflow = createProjectWorkflow(workspace, {
      brief:
        "Coordinate a complex multi-step incident analysis task with evidence, risks, and handoff",
      projectName: "Incident Analysis",
      outputDir: "generated/incident-analysis-workflow",
      runGates: true,
      gateNames: ["plan validation", "dry run", "smoke"],
    });

    expect(workflow.targetType).toBe("complex_task");
    expect(workflow.architecture.modules.map((module) => module.name)).toEqual(
      expect.arrayContaining([
        "intake",
        "planner",
        "executor",
        "verification",
        "observability",
        "handoff",
      ]),
    );
    expect(workflow.fileTree.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "incident-analysis/workflow/requirements.md",
        "incident-analysis/workflow/task-graph.json",
        "incident-analysis/src/planner/task-graph.ts",
        "incident-analysis/src/verification/gates.ts",
      ]),
    );
    expect(workflow.gateResults?.map((result) => result.name)).toEqual([
      "plan validation",
      "dry run",
      "smoke",
    ]);
    expect(
      workflow.gateResults?.every((result) => result.status === "passed"),
    ).toBe(true);
  });

  test("scaffolds a guarded OS starter tree on request", () => {
    const workspace = tempWorkspace();

    const workflow = createProjectWorkflow(workspace, {
      brief: "Sketch OS: bootloader, kernel, display driver, and shell",
      projectName: "Sketch OS",
      targetType: "os",
      outputDir: "generated/sketch-os-workflow",
      scaffoldFiles: true,
    });

    const outputDir = path.join(workspace, "generated", "sketch-os-workflow");
    const bootPath = path.join(outputDir, "sketch-os", "boot", "boot.asm");
    const kernelPath = path.join(outputDir, "sketch-os", "kernel", "main.c");
    const makefilePath = path.join(outputDir, "sketch-os", "Makefile");

    expect(workflow.outputDir).toBe(outputDir);
    expect(workflow.scaffoldRoot).toBe(outputDir);
    expect(workflow.scaffoldedFiles).toEqual(
      expect.arrayContaining([bootPath, kernelPath, makefilePath]),
    );
    expect(workflow.skippedFiles).toEqual([]);
    expect(fs.readFileSync(bootPath, "utf-8")).toContain("dw 0xaa55");
    expect(fs.readFileSync(kernelPath, "utf-8")).toContain("void kernel_init");
    expect(fs.readFileSync(makefilePath, "utf-8")).toContain("smoke:");

    const persistedWorkflow = JSON.parse(
      fs.readFileSync(path.join(outputDir, "workflow.json"), "utf-8"),
    );
    expect(persistedWorkflow.scaffoldedFiles).toEqual(
      expect.arrayContaining([bootPath, kernelPath, makefilePath]),
    );
  });

  test("skips existing scaffold files unless overwrite is enabled", () => {
    const workspace = tempWorkspace();
    const input = {
      brief: "Sketch OS: bootloader, kernel, display driver, and shell",
      projectName: "Sketch OS",
      targetType: "os" as const,
      outputDir: "generated/sketch-os-workflow",
      scaffoldFiles: true,
    };

    createProjectWorkflow(workspace, input);
    const bootPath = path.join(
      workspace,
      "generated",
      "sketch-os-workflow",
      "sketch-os",
      "boot",
      "boot.asm",
    );
    fs.writeFileSync(bootPath, "custom boot sector", "utf-8");

    const skipped = createProjectWorkflow(workspace, input);

    expect(skipped.skippedFiles).toEqual(expect.arrayContaining([bootPath]));
    expect(fs.readFileSync(bootPath, "utf-8")).toBe("custom boot sector");

    const overwritten = createProjectWorkflow(workspace, {
      ...input,
      overwrite: true,
    });

    expect(overwritten.scaffoldedFiles).toEqual(
      expect.arrayContaining([bootPath]),
    );
    expect(overwritten.skippedFiles).toEqual([]);
    expect(fs.readFileSync(bootPath, "utf-8")).toContain("boot scaffold");
  });

  test("still accepts a workspace path string for legacy callers", () => {
    const workspace = tempWorkspace();

    const workflow = createProjectWorkflow(workspace, {
      brief: "Build a simple dashboard",
      outputDir: "generated/legacy-workflow",
    });

    expect(workflow.outputDir).toBe(
      path.join(workspace, "generated", "legacy-workflow"),
    );
  });

  test("allows output directories outside the workspace for computer-based agent", () => {
    const workspace = tempWorkspace();
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Hiro-outside-"),
    );

    const workflow = createProjectWorkflow(workspace, {
      brief: "Build outside",
      outputDir: outsideDir,
    });

    expect(workflow.outputDir).toBe(outsideDir);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  test("rejects gate execution when file writing is disabled", () => {
    const workspace = tempWorkspace();

    expect(() =>
      createProjectWorkflow(workspace, {
        brief: "Build and verify without files",
        writeFiles: false,
        runGates: true,
      }),
    ).toThrow(/run_gates requires write_files/);
  });

  test("has a built-in tool schema for agent and MCP exposure", () => {
    const schema = ToolRegistrySchemas.projectWorkflowSchemas()[0];

    expect(schema.function.name).toBe("project_workflow_create");
    expect(schema.function.parameters.required).toEqual(["brief"]);
    expect(
      (schema.function.parameters.properties as Record<string, unknown>)
        .target_type,
    ).toMatchObject({
      enum: [
        "app",
        "website",
        "library",
        "game",
        "automation",
        "simulation",
        "complex_task",
        "os",
        "other",
      ],
    });
    expect(
      (schema.function.parameters.properties as Record<string, unknown>)
        .scaffold_files,
    ).toMatchObject({ type: "boolean" });
    expect(
      (schema.function.parameters.properties as Record<string, unknown>)
        .overwrite,
    ).toMatchObject({ type: "boolean" });
    expect(
      (schema.function.parameters.properties as Record<string, unknown>)
        .run_gates,
    ).toMatchObject({ type: "boolean" });
    expect(
      (schema.function.parameters.properties as Record<string, unknown>)
        .gate_names,
    ).toMatchObject({ type: "array" });
  });
});
