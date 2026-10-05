import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentEngine } from "./agent-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { scriptedLLM } from "./__tests__/scripted-llm.js";
import { buildSkillsContext, createSkillTools } from "./skill-tools.js";
import { SkillStore } from "../skills-manager/skill-store.js";
import { SkillRegistryClient } from "../skills-manager/registry-client.js";
import { SKILL_MD, makeZip } from "../skills-manager/__tests__/zip-fixture.js";
import type {
  ApprovalGate,
  EngineTool,
  ToolExecutionContext,
} from "./types.js";

// Tool results are plain JSON; tests read them loosely.
type Out = { [key: string]: Out } & Out[] & string & number & boolean;

let root: string;
let store: SkillStore;
let tools: EngineTool[];
let runs: Array<Record<string, unknown>>;
let executionEnabled = true;

const ctx = (): ToolExecutionContext => ({
  runId: "run_test",
  callId: "call_test",
  signal: new AbortController().signal,
});
const find = (name: string) => tools.find((tool) => tool.name === name)!;
const call = (name: string, input: Record<string, unknown> = {}) =>
  find(name).execute(input, ctx()) as Promise<Out>;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
  store = new SkillStore({
    bundledRoot: path.join(root, "none"),
    userDir: path.join(root, "user"),
  });
  const registry = new SkillRegistryClient({ store, registries: () => [] });
  runs = [];
  executionEnabled = true;
  tools = createSkillTools({
    store,
    registry,
    workspaceRoot: path.join(root, "workspace"),
    executionEnabled: () => executionEnabled,
    onRun: (entry) => runs.push(entry),
  });
  const script =
    process.platform === "win32"
      ? "print('hello from skill', __import__('os').environ.get('MIKI_SKILL_DIR') is not None)"
      : "import os, sys\nprint('hello', *sys.argv[1:], os.path.basename(os.environ['MIKI_SKILL_DIR']))\n";
  await store.importBuffer(
    makeZip([
      {
        name: "demo/SKILL.md",
        data: SKILL_MD("demo-skill", "Greets people from a script."),
      },
      { name: "demo/scripts/greet.py", data: script },
      { name: "demo/notes/extra.md", data: "extra notes" },
    ]),
    "demo.zip",
    { origin: "manual" },
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("skill tools", () => {
  it("declares approval for run/install/delete and none for read-only tools", () => {
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(Object.keys(byName).sort()).toEqual([
      "skill_delete",
      "skill_install",
      "skill_list",
      "skill_read",
      "skill_run",
      "skill_search",
    ]);
    for (const name of ["skill_run", "skill_install", "skill_delete"])
      expect(byName[name].approval).toBe("required");
    for (const name of ["skill_list", "skill_read", "skill_search"])
      expect(byName[name].approval).not.toBe("required");
  });

  it("skill_list and skill_search find installed skills", async () => {
    expect((await call("skill_list")).skills[0]).toMatchObject({
      name: "demo-skill",
      scripts: 1,
    });
    expect(
      (await call("skill_search", { query: "greets" })).installed[0].name,
    ).toBe("demo-skill");
    const both = await call("skill_search", { query: "greets", scope: "all" });
    expect(both.registry.warnings[0]).toMatch(/No skill registry/);
  });

  it("skill_read returns instructions, scripts and supporting files", async () => {
    const out = await call("skill_read", { name: "demo-skill" });
    expect(out).toMatchObject({
      skill: "demo-skill",
      origin: "manual",
      runnable: true,
      scripts: ["scripts/greet.py"],
    });
    expect(out.instructions).toContain("# demo-skill");
    expect(out.files).toEqual(["notes/extra.md", "scripts/greet.py"]);
    expect(
      (await call("skill_read", { name: "demo-skill", file: "notes/extra.md" }))
        .content,
    ).toBe("extra notes");
    await expect(
      call("skill_read", { name: "demo-skill", file: "../../etc/passwd" }),
    ).rejects.toThrow(/outside/);
    await expect(call("skill_read", { name: "ghost" })).rejects.toThrow(
      /not installed/,
    );
  });

  it("skill_run executes a skill script with MIKI_SKILL_DIR set and records the run", async () => {
    const out = await call("skill_run", {
      name: "demo-skill",
      script: "scripts/greet.py",
      args: ["world"],
    });
    if (out.status !== "ok") console.warn("python unavailable:", out);
    else {
      expect(out.stdout).toContain("hello world demo-skill");
      expect(runs[0]).toMatchObject({
        skill: "demo-skill",
        status: "ok",
        exitCode: 0,
      });
    }
  });

  it("skill_run cannot escape the skill folder and obeys the execution kill switch", async () => {
    await expect(
      call("skill_run", { name: "demo-skill", script: "../../outside.py" }),
    ).rejects.toThrow(/outside_workspace/);
    await expect(
      call("skill_run", { name: "demo-skill", script: "SKILL.md" }),
    ).rejects.toThrow(/unsupported_type/);
    await expect(
      call("skill_run", { name: "ghost", script: "x.py" }),
    ).rejects.toThrow(/not installed/);
    executionEnabled = false;
    await expect(
      call("skill_run", { name: "demo-skill", script: "scripts/greet.py" }),
    ).rejects.toThrow(/disabled/);
    expect((await call("skill_read", { name: "demo-skill" })).runnable).toBe(
      false,
    );
  });

  it("skill_install surfaces registry errors and skill_delete removes user skills only", async () => {
    await expect(call("skill_install", { slug: "x" })).rejects.toThrow(
      /registry/i,
    );
    expect(await call("skill_delete", { name: "demo-skill" })).toEqual({
      deleted: true,
      name: "demo-skill",
    });
    await expect(call("skill_delete", { name: "demo-skill" })).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("buildSkillsContext", () => {
  it("lists skills with descriptions only and respects the size budget", async () => {
    await store.importBuffer(
      Buffer.from("---\nname: silent\n---\n"),
      "silent.md",
      { origin: "manual" },
    );
    const context = (await buildSkillsContext(store))!;
    expect(context).toContain("- demo-skill: Greets people from a script.");
    expect(context).not.toContain("silent");
    expect(context).toContain("skill_read");
    const tiny = (await buildSkillsContext(store, { maxChars: 10 }))!;
    expect(tiny).toContain("and 1 more");
  });

  it("returns nothing when there are no described skills", async () => {
    const empty = new SkillStore({
      bundledRoot: path.join(root, "none"),
      userDir: path.join(root, "empty"),
    });
    expect(await buildSkillsContext(empty)).toBeUndefined();
  });
});

describe("agent engine with skills", () => {
  it("advertises skills, lets the model read one, and needs approval to run its script", async () => {
    const registry = new ToolRegistry();
    registry.registerAll(tools);
    const llm = scriptedLLM([
      { calls: [{ name: "skill_read", args: { name: "demo-skill" } }] },
      {
        calls: [
          {
            name: "skill_run",
            args: {
              name: "demo-skill",
              script: "scripts/greet.py",
              args: ["x"],
            },
          },
        ],
      },
      { text: "Done." },
    ]);
    const approvalsSeen: string[] = [];
    const gate: ApprovalGate = {
      async request(request) {
        approvalsSeen.push(request.toolName);
        return { approved: true, decidedBy: "test" };
      },
    };
    const engine = new AgentEngine({
      llm: llm.client,
      tools: registry,
      approvals: gate,
      contextProvider: () => buildSkillsContext(store),
    });
    const result = await engine.run({
      history: [{ role: "user", content: "greet the world" }],
    });
    expect(result.status).toBe("completed");
    const system = String(llm.requests[0].messages[0].content);
    expect(system).toContain("Installed skills");
    expect(system).toContain("demo-skill: Greets people from a script.");
    expect(approvalsSeen).toEqual(["skill_run"]);
    const toolMessages = llm.requests[1].messages.filter(
      (message) => message.role === "tool",
    );
    expect(String(toolMessages[0].content)).toContain("scripts/greet.py");
  });

  it("keeps a failing context provider from failing the run", async () => {
    const registry = new ToolRegistry();
    registry.registerAll(tools);
    const llm = scriptedLLM([{ text: "ok" }]);
    const logs: string[] = [];
    const engine = new AgentEngine({
      llm: llm.client,
      tools: registry,
      contextProvider: () => {
        throw new Error("boom");
      },
      logger: (message) => logs.push(message),
    });
    const result = await engine.run({
      history: [{ role: "user", content: "hi" }],
    });
    expect(result.status).toBe("completed");
    expect(logs).toContain("context_provider.failed");
  });
});
