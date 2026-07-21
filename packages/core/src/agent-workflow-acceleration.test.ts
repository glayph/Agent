import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ChatMessage } from "@hiro/config";
import { AgentOrchestrator } from "./agent.js";
import { type RuntimePaths } from "./paths.js";

function makeRuntimePaths(workspaceDir: string): RuntimePaths {
  return {
    configDir: path.join(workspaceDir, "config"),
    dataDir: path.join(workspaceDir, "data"),
    skillsDir: path.join(workspaceDir, "src", "skills"),
    cacheDir: path.join(workspaceDir, "data", "cache"),
    binDir: path.join(workspaceDir, "bin"),
    docsDir: path.join(workspaceDir, "docs"),
    outputDir: path.join(workspaceDir, "output"),
    sourceDir: workspaceDir,
  };
}

function createRawToolCalls(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `tool-call-${index}`,
    function: {
      name: "file_read",
      arguments: JSON.stringify({ path: `src/fixture-${index}.ts` }),
    },
  }));
}

describe("AgentOrchestrator workflow acceleration", () => {
  let workspaceDir: string | null = null;
  let orchestrator: AgentOrchestrator | null = null;

  afterEach(async () => {
    if (orchestrator) {
      await orchestrator.stopBackgroundTasks();
      orchestrator = null;
    }
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = null;
    }
  });

  it("uses turbo parallelism for explicit superfast tool batches", async () => {
    workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Hiro-agent-acceleration-"),
    );
    const configDir = path.join(workspaceDir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "agent.yaml"),
      [
        "concurrency:",
        "  maxConcurrentTasks: 2",
        "  maxParallelToolCalls: 2",
        "",
      ].join("\n"),
      "utf8",
    );

    orchestrator = new AgentOrchestrator(makeRuntimePaths(workspaceDir));
    const internal = orchestrator as unknown as {
      _scoreToolConfidence: () => Promise<void>;
      _executePlannedToolInvocation: (
        sessionId: string,
        planned: {
          index: number;
          invocation: { tcId: string; toolName: string };
        },
      ) => Promise<{
        index: number;
        events: string[];
        toolMessage: ChatMessage;
        ok: boolean;
      }>;
      _executeToolCallsAndYield: (
        sessionId: string,
        userMessage: string,
        toolCalls: ReturnType<typeof createRawToolCalls>,
        llmMessages: ChatMessage[],
        turn: number,
      ) => AsyncGenerator<string, void, unknown>;
    };

    let active = 0;
    let maxActive = 0;
    internal._scoreToolConfidence = async () => {};
    internal._executePlannedToolInvocation = async (_sessionId, planned) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;

      return {
        index: planned.index,
        events: [
          JSON.stringify({
            type: "tool_result",
            tool: planned.invocation.toolName,
            output: "ok",
          }),
        ],
        ok: true,
        toolMessage: {
          role: "tool",
          tool_call_id: planned.invocation.tcId,
          name: planned.invocation.toolName,
          content: "ok",
        },
      };
    };

    const llmMessages: ChatMessage[] = [];
    const events: Array<Record<string, unknown>> = [];
    for await (const rawEvent of internal._executeToolCallsAndYield(
      "test-session",
      "Superfast read these files quickly and summarize the implementation status",
      createRawToolCalls(6),
      llmMessages,
      0,
    )) {
      events.push(JSON.parse(rawEvent) as Record<string, unknown>);
    }

    const executionPlan = events.find(
      (event) => event.type === "tool_execution_plan",
    );
    expect(executionPlan).toEqual(
      expect.objectContaining({
        total: 6,
        parallelizable: true,
        acceleration_mode: "turbo",
        max_parallel_tool_calls: 6,
        decision_pattern: "turbo_implementation",
        speed_class: "fastest",
        expected_latency: "seconds_to_few_minutes",
        verification_depth: "focused",
      }),
    );
    expect(maxActive).toBe(6);
    expect(llmMessages).toHaveLength(6);
  });

  it("persists terminal LLM errors as assistant history messages", async () => {
    workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Hiro-agent-error-history-"),
    );
    const configDir = path.join(workspaceDir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "agent.yaml"),
      ["agent:", "  memory:", "    long_term_enabled: false", ""].join("\n"),
      "utf8",
    );
    orchestrator = new AgentOrchestrator(makeRuntimePaths(workspaceDir));
    const internal = orchestrator as unknown as {
      _callLlmApi: () => Promise<never>;
    };
    internal._callLlmApi = async () => {
      throw new Error("Invalid model name");
    };

    const events: Array<Record<string, unknown>> = [];
    for await (const rawEvent of orchestrator.runAgentLoop(
      "error-history-session",
      "Hello",
    )) {
      events.push(JSON.parse(rawEvent) as Record<string, unknown>);
    }

    const messages =
      (
        orchestrator as unknown as {
          _messageHistory: Map<string, ChatMessage[]>;
        }
      )._messageHistory.get("error-history-session") || [];

    expect(events.some((event) => event.type === "stream_chunk")).toBe(true);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "user",
      content: "Hello",
    });
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toContain("Error calling LLM");
    expect(messages[1].content).toContain("Please check credentials");
  });
});
