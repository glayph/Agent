import {
  asRecord,
  previewToolArgs,
  previewToolOutput,
  toolPath,
  toolActionDescription,
  toolResultDescription,
  inferInspectorNodeType,
  sendMikiFrame,
  SOCKET_OPEN,
  buildInspectorThoughtMessage,
  type MinimalSocket,
} from "./inspector-events.js";

describe("asRecord", () => {
  it("passes through plain objects", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it("falls back to {} for arrays, null, and primitives", () => {
    expect(asRecord([1, 2])).toEqual({});
    expect(asRecord(null)).toEqual({});
    expect(asRecord(undefined)).toEqual({});
    expect(asRecord("string")).toEqual({});
    expect(asRecord(42)).toEqual({});
  });
});

describe("previewToolArgs", () => {
  it("returns the full JSON when under the limit", () => {
    expect(previewToolArgs({ path: "a.txt" }, 100)).toBe('{"path":"a.txt"}');
  });

  it("truncates with an ellipsis when over the limit", () => {
    const result = previewToolArgs({ path: "a-very-long-path.txt" }, 10);
    expect(result).toHaveLength(11); // 10 chars + ellipsis
    expect(result.endsWith("…")).toBe(true);
  });

  it("treats missing/falsy input as an empty object", () => {
    expect(previewToolArgs(undefined, 100)).toBe("{}");
    expect(previewToolArgs(null, 100)).toBe("{}");
  });
});

describe("previewToolOutput", () => {
  it("keeps string output as-is when under the limit", () => {
    expect(previewToolOutput("hello", 100)).toBe("hello");
  });

  it("JSON-stringifies non-string output", () => {
    expect(previewToolOutput({ ok: true }, 100)).toBe('{"ok":true}');
  });

  it("JSON-stringifies undefined output as an empty JSON string", () => {
    // `output ?? ""` is not typeof "string" as an expression result check —
    // the implementation's typeof-guard runs on the *original* `output`
    // (undefined), so it falls to JSON.stringify(output ?? "") ->
    // JSON.stringify("") -> the two-character string '""'.
    expect(previewToolOutput(undefined, 100)).toBe('""');
  });

  it("truncates long output with an ellipsis", () => {
    const result = previewToolOutput("x".repeat(50), 10);
    expect(result).toBe(`${"x".repeat(10)}…`);
  });
});

describe("toolPath", () => {
  it("extracts a trimmed path field", () => {
    expect(toolPath({ path: "  /tmp/foo.txt  " })).toBe("/tmp/foo.txt");
  });

  it("falls back to a generic label when path is missing or blank", () => {
    expect(toolPath({})).toBe("the requested path");
    expect(toolPath({ path: "   " })).toBe("the requested path");
    expect(toolPath({ path: 123 })).toBe("the requested path");
    expect(toolPath(null)).toBe("the requested path");
  });
});

describe("toolActionDescription", () => {
  it("describes file_read", () => {
    expect(toolActionDescription("file_read", { path: "notes.md" })).toBe(
      "Reading file: notes.md",
    );
  });

  it("describes file_write", () => {
    expect(toolActionDescription("file_write", { path: "notes.md" })).toBe(
      "Editing file: notes.md",
    );
  });

  it("describes a dry-run file_delete distinctly from a real delete", () => {
    expect(
      toolActionDescription("file_delete", { path: "notes.md", dryRun: true }),
    ).toBe("Checking deletion without changing the file: notes.md");
    expect(
      toolActionDescription("file_delete", {
        path: "notes.md",
        dryRun: false,
      }),
    ).toBe("Deleting file: notes.md");
  });

  it("falls back to a generic 'Running tool' description for anything else", () => {
    expect(toolActionDescription("shell_execute", {})).toBe(
      "Running tool: shell_execute",
    );
    expect(toolActionDescription("plugin_hubspot_create_contact", {})).toBe(
      "Running tool: plugin_hubspot_create_contact",
    );
  });

  it("treats a non-string tool name as 'tool'", () => {
    expect(toolActionDescription(undefined, {})).toBe("Running tool: tool");
  });
});

describe("toolResultDescription", () => {
  it("rewrites the action verb to a completed-tense on success", () => {
    expect(
      toolResultDescription("file_read", { path: "a.txt" }, true, "", 12, 200),
    ).toBe("File read completed: a.txt (12 ms)");
    expect(
      toolResultDescription(
        "file_write",
        { path: "a.txt" },
        true,
        "",
        undefined,
        200,
      ),
    ).toBe("File edit completed: a.txt");
    expect(
      toolResultDescription(
        "file_delete",
        { path: "a.txt", dryRun: true },
        true,
        "",
        5,
        200,
      ),
    ).toBe("Deletion check completed: a.txt (5 ms)");
    expect(
      toolResultDescription(
        "file_delete",
        { path: "a.txt" },
        true,
        "",
        5,
        200,
      ),
    ).toBe("File deletion completed: a.txt (5 ms)");
  });

  it("appends a truncated failure detail on failure", () => {
    const result = toolResultDescription(
      "shell_execute",
      {},
      false,
      "permission denied",
      30,
      200,
    );
    expect(result).toBe(
      "Running tool: shell_execute failed: permission denied (30 ms)",
    );
  });

  it("omits the detail suffix when there is no output to show", () => {
    const result = toolResultDescription(
      "shell_execute",
      {},
      false,
      "",
      undefined,
      200,
    );
    expect(result).toBe("Running tool: shell_execute failed");
  });

  it("omits timing when durationMs is not a finite number", () => {
    const result = toolResultDescription(
      "file_read",
      { path: "a.txt" },
      true,
      "",
      Number.NaN,
      200,
    );
    expect(result).toBe("File read completed: a.txt");
  });
});

describe("inferInspectorNodeType", () => {
  it("classifies real plugin tool names (plugin_<pluginName>_<contractName>)", () => {
    expect(inferInspectorNodeType("plugin_hubspot_create_contact")).toBe(
      "plugin",
    );
    expect(inferInspectorNodeType("plugin_gmail_send")).toBe("plugin");
  });

  it("classifies skill tool names", () => {
    expect(inferInspectorNodeType("skill_search")).toBe("skill");
    expect(inferInspectorNodeType("skill_create")).toBe("skill");
  });

  it("classifies file tool names", () => {
    expect(inferInspectorNodeType("file_read")).toBe("file");
    expect(inferInspectorNodeType("file_write")).toBe("file");
    expect(inferInspectorNodeType("file_delete")).toBe("file");
  });

  it("classifies shell/command tool names", () => {
    expect(inferInspectorNodeType("shell_execute")).toBe("command");
  });

  it("classifies workflow/orchestration tool names as pattern", () => {
    expect(inferInspectorNodeType("project_workflow_create")).toBe("pattern");
  });

  it("falls back to 'tool' for anything unrecognized", () => {
    expect(inferInspectorNodeType("web_search")).toBe("tool");
    expect(inferInspectorNodeType("model_list")).toBe("tool");
  });
});

describe("sendMikiFrame", () => {
  function fakeSocket(readyState: number): MinimalSocket & { sent: string[] } {
    return {
      readyState,
      sent: [] as string[],
      send(data: string) {
        this.sent.push(data);
      },
    };
  }

  it("sends JSON only when the socket is open", () => {
    const socket = fakeSocket(SOCKET_OPEN);
    sendMikiFrame(socket, { type: "node.spawn", payload: { ok: true } });
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "node.spawn",
      payload: { ok: true },
    });
  });

  it("does not send when the socket is not open (connecting/closing/closed)", () => {
    for (const state of [0, 2, 3]) {
      const socket = fakeSocket(state);
      sendMikiFrame(socket, { type: "node.spawn" });
      expect(socket.sent).toHaveLength(0);
    }
  });
});

describe("buildInspectorThoughtMessage", () => {
  it("returns null for blank or whitespace-only content, sending nothing", () => {
    expect(
      buildInspectorThoughtMessage({
        sessionId: "s1",
        runId: "r1",
        content: "   ",
        category: "Plan",
        modelName: "local-model",
      }),
    ).toBeNull();
  });

  it("marks the message kind='thought' and inspector_only=true, matching the contract the frontend relies on to hide it from normal chat", () => {
    const message = buildInspectorThoughtMessage({
      sessionId: "s1",
      runId: "r1",
      content: "Checking the file before editing it.",
      category: "Verification",
      modelName: "local-model",
      now: () => 1_700_000_000_000,
      idGenerator: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });

    expect(message).toEqual({
      type: "message.create",
      id: "id-1",
      session_id: "s1",
      timestamp: 1_700_000_000_000,
      payload: {
        message_id: "r1-thought-id-2",
        run_id: "r1",
        content: "Checking the file before editing it.",
        kind: "thought",
        thought_category: "Verification",
        inspector_only: true,
        model_name: "local-model",
      },
    });
  });

  it("trims content before sending", () => {
    const message = buildInspectorThoughtMessage({
      sessionId: "s1",
      runId: "r1",
      content: "  padded thought  ",
      category: "Progress",
      modelName: "local-model",
    });
    expect(message?.payload).toMatchObject({
      content: "padded thought",
    });
  });

  it("generates independent ids for the envelope and the message_id suffix", () => {
    let calls = 0;
    const message = buildInspectorThoughtMessage({
      sessionId: "s1",
      runId: "r1",
      content: "hello",
      category: "Action",
      modelName: "local-model",
      idGenerator: () => `call-${++calls}`,
    });
    expect(calls).toBe(2);
    expect(message?.id).toBe("call-1");
    expect((message?.payload as Record<string, unknown>).message_id).toBe(
      "r1-thought-call-2",
    );
  });
});
