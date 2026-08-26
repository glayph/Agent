import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ChatMessage } from "@miki/config";
import {
  AgentOrchestrator,
  detectAgentResponseContract,
  validateAgentResponseContract,
} from "./agent.js";
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
  it("detects and validates explicit response contracts", () => {
    const contract = detectAgentResponseContract(
      "Return only a Python function named average_line_revenue(rows), with no markdown or explanation. Do not use tools.",
    );
    expect(contract).toEqual({
      kind: "function",
      name: "average_line_revenue",
    });
    expect(
      validateAgentResponseContract(
        "def average_line_revenue(rows):\\n    if not rows:",
        contract!,
      ),
    ).toBe(false);
    expect(
      validateAgentResponseContract(
        "def average_line_revenue(rows):\\n    return 0.0",
        contract!,
      ),
    ).toBe(true);
  });
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
      path.join(os.tmpdir(), "Miki-agent-acceleration-"),
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
      path.join(os.tmpdir(), "Miki-agent-error-history-"),
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
    expect(messages[1].content).toContain("Invalid model name");
  });

  it("terminates an explicit no-tool turn after the first usable answer", async () => {
    workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-agent-no-tool-finalization-"),
    );
    const configDir = path.join(workspaceDir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "agent.yaml"),
      ["agent:", "  resource:", "    quality_retry_limit: 0", ""].join("\n"),
      "utf8",
    );
    orchestrator = new AgentOrchestrator(makeRuntimePaths(workspaceDir));
    const internal = orchestrator as unknown as {
      _callLlmApi: () => Promise<unknown>;
    };
    let calls = 0;
    internal._callLlmApi = async () => {
      calls += 1;
      return {
        choices: [{ message: { content: "The direct answer is ready." } }],
      };
    };

    const events: Array<Record<string, unknown>> = [];
    for await (const rawEvent of orchestrator.runAgentLoop(
      "no-tool-session",
      "Do not use tools. Answer directly with one short sentence.",
    )) {
      events.push(JSON.parse(rawEvent) as Record<string, unknown>);
    }

    expect(calls).toBe(1);
    expect(events.filter((event) => event.type === "stream_done")).toHaveLength(
      1,
    );
    expect(events.find((event) => event.type === "stream_chunk")).toEqual(
      expect.objectContaining({ content: "The direct answer is ready." }),
    );
  });

  it("repairs malformed structured output into the exact requested JSON schema", async () => {
    workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-agent-response-contract-"),
    );
    const configDir = path.join(workspaceDir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "agent.yaml"),
      ["agent:", "  resource:", "    quality_retry_limit: 0", ""].join("\n"),
      "utf8",
    );
    orchestrator = new AgentOrchestrator(makeRuntimePaths(workspaceDir));
    const internal = orchestrator as unknown as {
      _callLlmApi: () => Promise<unknown>;
    };
    let calls = 0;
    internal._callLlmApi = async () => {
      calls += 1;
      return {
        choices: [
          {
            message: {
              content:
                calls === 1
                  ? '{"project":"Aurora Desk","owner":"Mina","priority":"high","due\\_date":"2026-09-15"}'
                  : '{"project":"Aurora Desk","owner":"Mina","priority":"high","due_date":"2026-09-15"}',
            },
          },
        ],
      };
    };

    const events: Array<Record<string, unknown>> = [];
    for await (const rawEvent of orchestrator.runAgentLoop(
      "response-contract-session",
      "Return valid JSON with exactly these fields: project, owner, priority, due\\_date. Do not use tools.",
    )) {
      events.push(JSON.parse(rawEvent) as Record<string, unknown>);
    }

    expect(calls).toBe(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "stream_chunk",
        content:
          '{"project":"Aurora Desk","owner":"Mina","priority":"high","due_date":"2026-09-15"}',
      }),
    );
    expect(events.filter((event) => event.type === "stream_done")).toHaveLength(
      1,
    );
  });

  it("repairs an incomplete code-only function response", async () => {
    workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-agent-code-contract-"),
    );
    const configDir = path.join(workspaceDir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "agent.yaml"),
      ["agent:", "  resource:", "    quality_retry_limit: 0", ""].join("\n"),
      "utf8",
    );
    orchestrator = new AgentOrchestrator(makeRuntimePaths(workspaceDir));
    const internal = orchestrator as unknown as {
      _callLlmApi: () => Promise<unknown>;
    };
    let calls = 0;
    internal._callLlmApi = async () => {
      calls += 1;
      return {
        choices: [
          {
            message: {
              content:
                calls === 1
                  ? "def average_line_revenue(rows):\\n    if not rows:"
                  : "def average_line_revenue(rows):\\n    if not rows:\\n        return 0.0\\n    return sum(row['units'] * row['unit_price'] for row in rows) / len(rows)",
            },
          },
        ],
      };
    };

    const events: Array<Record<string, unknown>> = [];
    for await (const rawEvent of orchestrator.runAgentLoop(
      "code-contract-session",
      "Return only a Python function named average_line_revenue(rows), with no markdown or explanation. Do not use tools.",
    )) {
      events.push(JSON.parse(rawEvent) as Record<string, unknown>);
    }

    expect(calls).toBe(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "stream_chunk",
        content: expect.stringContaining("return 0.0"),
      }),
    );
  });

  it("finalizes a concise response without appending a safe-stop fallback", async () => {
    workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-agent-concise-final-"),
    );
    orchestrator = new AgentOrchestrator(makeRuntimePaths(workspaceDir));
    const internal = orchestrator as unknown as {
      _callLlmApi: () => Promise<unknown>;
    };
    internal._callLlmApi = async () => ({
      choices: [
        {
          message: {
            content:
              "[Big Buck Bunny on YouTube](https://www.youtube.com/watch?v=aqz-KE-bpKQ)",
          },
        },
      ],
    });

    const events: Array<Record<string, unknown>> = [];
    for await (const rawEvent of orchestrator.runAgentLoop(
      "concise-final-session",
      "Return the verified link.",
    )) {
      events.push(JSON.parse(rawEvent) as Record<string, unknown>);
    }

    const streamed = events
      .filter((event) => event.type === "stream_chunk")
      .map((event) => String(event.content ?? ""))
      .join("\n");
    expect(streamed).toContain("Big Buck Bunny on YouTube");
    expect(streamed).not.toContain("I could not produce a final answer");
    expect(events.filter((event) => event.type === "stream_done")).toHaveLength(
      1,
    );
  });

  it("finalizes a bounded tool-only loop with a safe summary", async () => {
    workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-agent-tool-only-finalization-"),
    );
    const configDir = path.join(workspaceDir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    orchestrator = new AgentOrchestrator(makeRuntimePaths(workspaceDir));
    const internal = orchestrator as unknown as {
      _callLlmApi: () => Promise<unknown>;
      _executeToolCallsAndYield: (
        sessionId: string,
        userMessage: string,
        toolCalls: unknown,
        llmMessages: ChatMessage[],
        turn: number,
      ) => AsyncGenerator<string, void, unknown>;
    };
    internal._callLlmApi = async () => ({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "tool-call-loop",
                function: {
                  name: "file_read",
                  arguments: JSON.stringify({ path: "fixture.md" }),
                },
              },
            ],
          },
        },
      ],
    });
    internal._executeToolCallsAndYield = async function* (
      _sessionId,
      _userMessage,
      _toolCalls,
      llmMessages,
    ) {
      llmMessages.push({
        role: "tool",
        name: "file_read",
        tool_call_id: "tool-call-loop",
        content: "ok",
      });
      yield JSON.stringify({
        type: "tool_result",
        tool: "file_read",
        ok: true,
        output: "ok",
      });
    };

    const events: Array<Record<string, unknown>> = [];
    for await (const rawEvent of orchestrator.runAgentLoop(
      "tool-only-session",
      "Read the fixture and complete the task.",
    )) {
      events.push(JSON.parse(rawEvent) as Record<string, unknown>);
    }

    expect(events.filter((event) => event.type === "stream_done")).toHaveLength(
      1,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "stream_chunk",
        content: expect.stringContaining("Completed tool steps: file_read."),
      }),
    );
  });
});
