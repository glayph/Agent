// Regression coverage for a memory-system review finding: tool calls
// (success and failure) were never written to memory, even though
// AgentMemoryIntegration.logToolCall() existed and was fully tested at
// the package level. _classifyMemoryCategory files any event with
// source: 'tool' as the "skill" category, so without this wiring the
// skill category was effectively unreachable from real agent usage.
//
// jest.config.cjs force-redirects every "*/memory-bridge.js" import to
// __mocks__/memory-bridge.ts, which always returns null from getMemory()
// (see that file's comment for why). To actually observe what agent.ts
// passes to memory.logToolCall(), we override that mock's exports for
// this file only via jest.mock() with an explicit factory, per the
// pattern the mock file itself documents.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgentOrchestrator } from "./agent.js";
import { type RuntimePaths } from "./paths.js";

const logToolCall = jest.fn();

jest.mock("./memory/memory-bridge.js", () => ({
  initMemory: () => null,
  closeMemory: () => {},
  getMemory: () => ({
    logInteraction: jest.fn(),
    logToolCall,
    getEnhancedSystemPrompt: (userMessage: string) => userMessage,
  }),
}));

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

describe("Agent tool calls are logged to memory", () => {
  let workspaceDir: string | null = null;
  let orchestrator: AgentOrchestrator | null = null;

  beforeEach(() => {
    logToolCall.mockClear();
  });

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

  function setUp() {
    workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "Miki-agent-memory-tool-log-"),
    );
    const configDir = path.join(workspaceDir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "agent.yaml"),
      ["concurrency:", "  maxConcurrentTasks: 2", ""].join("\n"),
      "utf8",
    );
    orchestrator = new AgentOrchestrator(makeRuntimePaths(workspaceDir));
    return orchestrator;
  }

  it("calls memory.logToolCall with tool name, args, output, and ok:true on success", async () => {
    const agent = setUp();
    const internal = agent as unknown as {
      _scoreToolConfidence: () => Promise<void>;
      tools: {
        executeToolStructured: (...args: unknown[]) => Promise<unknown>;
      };
      _executePlannedToolInvocation: (
        sessionId: string,
        planned: {
          index: number;
          invocation: { tcId: string; toolName: string; toolArgs: unknown };
          policy: {
            locks: unknown[];
            timeoutMs: number;
            retry: {
              maxAttempts: number;
              baseDelayMs: number;
              maxDelayMs: number;
            };
          };
        },
      ) => Promise<unknown>;
    };
    internal._scoreToolConfidence = async () => {};
    internal.tools.executeToolStructured = async () => ({
      success: true,
      output: "file contents here",
    });

    await internal._executePlannedToolInvocation("mem-log-session", {
      index: 0,
      invocation: {
        tcId: "tc-1",
        toolName: "file_read",
        toolArgs: { path: "src/index.ts" },
      },
      policy: {
        locks: [],
        timeoutMs: 5000,
        retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 },
      },
    });

    expect(logToolCall).toHaveBeenCalledTimes(1);
    expect(logToolCall).toHaveBeenCalledWith(
      "file_read",
      { path: "src/index.ts" },
      "file contents here",
      { sessionId: "mem-log-session", ok: true },
    );
  });

  it("calls memory.logToolCall with ok:false when the tool exhausts retries and fails", async () => {
    const agent = setUp();
    const internal = agent as unknown as {
      _scoreToolConfidence: () => Promise<void>;
      tools: {
        executeToolStructured: (...args: unknown[]) => Promise<unknown>;
      };
      _executePlannedToolInvocation: (
        sessionId: string,
        planned: {
          index: number;
          invocation: { tcId: string; toolName: string; toolArgs: unknown };
          policy: {
            locks: unknown[];
            timeoutMs: number;
            retry: {
              maxAttempts: number;
              baseDelayMs: number;
              maxDelayMs: number;
            };
          };
        },
      ) => Promise<unknown>;
    };
    internal._scoreToolConfidence = async () => {};
    internal.tools.executeToolStructured = async () => ({
      success: false,
      error: "permission denied",
    });

    await internal._executePlannedToolInvocation("mem-log-session-fail", {
      index: 0,
      invocation: {
        tcId: "tc-2",
        toolName: "shell_execute",
        toolArgs: { command: "rm -rf /forbidden" },
      },
      policy: {
        locks: [],
        timeoutMs: 5000,
        retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 },
      },
    });

    expect(logToolCall).toHaveBeenCalledTimes(1);
    const [toolName, toolArgs, output, metadata] = logToolCall.mock.calls[0];
    expect(toolName).toBe("shell_execute");
    expect(toolArgs).toEqual({ command: "rm -rf /forbidden" });
    expect(output).toContain("permission denied");
    expect(metadata).toEqual({ sessionId: "mem-log-session-fail", ok: false });
  });

  it("still calls memory.logToolCall with ok:false when the tool throws before running (e.g. lock failure)", async () => {
    const agent = setUp();
    const internal = agent as unknown as {
      toolLockManager: {
        acquireMany: (...args: unknown[]) => Promise<unknown>;
      };
      _executePlannedToolInvocation: (
        sessionId: string,
        planned: {
          index: number;
          invocation: { tcId: string; toolName: string; toolArgs: unknown };
          policy: {
            locks: unknown[];
            timeoutMs: number;
            retry: {
              maxAttempts: number;
              baseDelayMs: number;
              maxDelayMs: number;
            };
          };
        },
      ) => Promise<unknown>;
    };
    internal.toolLockManager.acquireMany = async () => {
      throw new Error("lock timeout after 5000ms");
    };

    await internal._executePlannedToolInvocation("mem-log-session-lock", {
      index: 0,
      invocation: {
        tcId: "tc-3",
        toolName: "file_write",
        toolArgs: { path: "src/shared.ts", content: "x" },
      },
      policy: {
        locks: ["src/shared.ts"],
        timeoutMs: 5000,
        retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 },
      },
    });

    expect(logToolCall).toHaveBeenCalledTimes(1);
    const [toolName, , output, metadata] = logToolCall.mock.calls[0];
    expect(toolName).toBe("file_write");
    expect(output).toContain("lock timeout");
    expect(metadata).toEqual({ sessionId: "mem-log-session-lock", ok: false });
  });

  it("does not throw or block the tool result when memory.logToolCall itself throws", async () => {
    const agent = setUp();
    logToolCall.mockImplementationOnce(() => {
      throw new Error("db is locked");
    });
    const internal = agent as unknown as {
      _scoreToolConfidence: () => Promise<void>;
      tools: {
        executeToolStructured: (...args: unknown[]) => Promise<unknown>;
      };
      _executePlannedToolInvocation: (
        sessionId: string,
        planned: {
          index: number;
          invocation: { tcId: string; toolName: string; toolArgs: unknown };
          policy: {
            locks: unknown[];
            timeoutMs: number;
            retry: {
              maxAttempts: number;
              baseDelayMs: number;
              maxDelayMs: number;
            };
          };
        },
      ) => Promise<{ ok: boolean }>;
    };
    internal._scoreToolConfidence = async () => {};
    internal.tools.executeToolStructured = async () => ({
      success: true,
      output: "ok",
    });

    const result = await internal._executePlannedToolInvocation(
      "mem-log-session-throw",
      {
        index: 0,
        invocation: { tcId: "tc-4", toolName: "file_read", toolArgs: {} },
        policy: {
          locks: [],
          timeoutMs: 5000,
          retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 },
        },
      },
    );

    expect(result.ok).toBe(true);
  });
});
