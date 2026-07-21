import {
  clearSessionPermissions,
  getSessionPermissionState,
  getSessionPermissions,
  getToolPermissionDecision,
  isToolEnabledForSession,
  recordToolPermissionDenial,
  setSessionPermissions,
} from "./session-permissions.js";

describe("MCP session permissions", () => {
  afterEach(() => clearSessionPermissions());

  test("defaults tools to enabled unless explicitly disabled", () => {
    expect(isToolEnabledForSession("s1", "shell_execute")).toBe(true);

    setSessionPermissions("s1", { shell_execute: false });

    expect(getSessionPermissions("s1")).toEqual({ shell_execute: false });
    expect(isToolEnabledForSession("s1", "shell_execute")).toBe(false);
    expect(isToolEnabledForSession("s1", "file_read")).toBe(true);
    expect(getToolPermissionDecision("s1", "shell_execute")).toMatchObject({
      toolName: "shell_execute",
      enabled: false,
      reason: "Tool is disabled for this session.",
      source: "session",
    });
  });

  test("sanitizes stored permissions and returns defensive copies", () => {
    const permissions = {
      shell_execute: false,
      file_read: "false",
      "__proto__.polluted": false,
      "bad tool": false,
    } as unknown as Record<string, boolean>;

    setSessionPermissions(" s1 ", permissions);
    permissions.shell_execute = true;

    const stored = getSessionPermissions("s1");
    expect(stored).toEqual({ shell_execute: false });

    stored.shell_execute = true;
    expect(isToolEnabledForSession("s1", "shell_execute")).toBe(false);
    expect(isToolEnabledForSession("s1", "file_read")).toBe(true);
  });

  test("records a sanitized permission timeline", () => {
    setSessionPermissions("s1", { shell_execute: false });
    setSessionPermissions("s1", { shell_execute: true, file_delete: false });

    const state = getSessionPermissionState("s1");
    expect(state.permissions).toEqual({
      shell_execute: true,
      file_delete: false,
    });
    expect(state.timeline.map((entry) => entry.toolName)).toEqual([
      "shell_execute",
      "shell_execute",
      "file_delete",
    ]);
    expect(state.timeline.map((entry) => entry.action)).toEqual([
      "deny",
      "grant",
      "deny",
    ]);
    state.timeline[0].toolName = "mutated";
    expect(getSessionPermissionState("s1").timeline[0].toolName).toBe(
      "shell_execute",
    );
  });

  test("records revoked session policy changes", () => {
    setSessionPermissions("s1", {
      shell_execute: true,
      file_delete: false,
    });
    setSessionPermissions("s1", { shell_execute: true });

    const state = getSessionPermissionState("s1");
    expect(state.permissions).toEqual({ shell_execute: true });
    expect(state.timeline.at(-1)).toMatchObject({
      toolName: "file_delete",
      action: "revoke",
      enabled: true,
    });
  });

  test("records denied tool calls with explanation and redacted args", () => {
    setSessionPermissions("s1", { shell_execute: false });
    const decision = getToolPermissionDecision("s1", "shell_execute");

    const denial = recordToolPermissionDenial("s1", decision, {
      actor: "mcp",
      requestId: "req-1",
      args: {
        cmd: "echo safe",
        api_key: "sk-secret-denial-history-canary",
        nested: { token: "secret-token-canary" },
      },
      deniedAt: "2026-06-04T00:00:00.000Z",
    });

    expect(denial).toMatchObject({
      toolName: "shell_execute",
      reason: "Tool is disabled for this session.",
      actor: "mcp",
      source: "session",
      requestId: "req-1",
      deniedAt: "2026-06-04T00:00:00.000Z",
    });
    expect(denial.argsPreview).toEqual({
      cmd: "echo safe",
      api_key: "[REDACTED]",
      nested: { token: "[REDACTED]" },
    });

    const state = getSessionPermissionState("s1");
    expect(state.denials).toHaveLength(1);
    state.denials[0].toolName = "mutated";
    (state.denials[0].argsPreview?.nested as Record<string, unknown>).token =
      "mutated";
    expect(getSessionPermissionState("s1").denials[0].toolName).toBe(
      "shell_execute",
    );
    expect(
      (
        getSessionPermissionState("s1").denials[0].argsPreview
          ?.nested as Record<string, unknown>
      ).token,
    ).toBe("[REDACTED]");
  });
});
