import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApprovalInbox } from "../../security/approval-inbox.js";
import {
  destructiveApprovalGate,
  consumeDestructiveApproval,
  isDestructiveShellCommand,
} from "./destructive-gate.js";

function makeConfigDir(agentYaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-gate-test-"));
  fs.writeFileSync(path.join(dir, "agent.yaml"), agentYaml, "utf-8");
  return dir;
}

function makeInbox(): { inbox: ApprovalInbox; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-gate-inbox-"));
  const filePath = path.join(dir, "approvals.json");
  return { inbox: new ApprovalInbox(filePath), filePath };
}

const DEFAULT_YAML = `
agent:
  tools:
    auto_approve_safe: true
    require_confirm_destructive: true
    require_confirm_computer_use: true
`;

describe("destructiveApprovalGate — computer-use actions", () => {
  it("blocks computer_click_at without approval and never returns a gate to consume", () => {
    const configDir = makeConfigDir(DEFAULT_YAML);
    const { inbox } = makeInbox();
    const { gate, response } = destructiveApprovalGate({
      approvalInbox: inbox,
      configDir,
      toolName: "computer_click_at",
      resource: "computer:click_at:100,200",
      args: { x: 100, y: 200 },
    });
    expect(gate).toBeNull();
    expect(response).not.toBeNull();
    const parsed = JSON.parse(response as string);
    expect(parsed.approval_required).toBe(true);
    expect(parsed.tool).toBe("computer_click_at");
    expect(typeof parsed.request_id).toBe("string");
  });

  it("lets the same call through once approved via the Web UI operator path, and consume succeeds", () => {
    const configDir = makeConfigDir(DEFAULT_YAML);
    const { inbox } = makeInbox();
    const args = { keys: "alt+f4" };

    // Step 1: model calls the tool, gets an approval_required response.
    const first = destructiveApprovalGate({
      approvalInbox: inbox,
      configDir,
      toolName: "computer_hotkey",
      resource: "computer:hotkey:alt+f4",
      args,
    });
    expect(first.response).not.toBeNull();
    const { request_id } = JSON.parse(first.response as string);

    // Step 2: the owner approves from the authenticated Web UI (no raw
    // token involved — that's the same approveByOperator() path the real
    // admin approvals endpoint uses).
    inbox.approveByOperator(request_id, "owner");

    // Step 3: model retries the identical tool call with approval_request_id.
    const retry = destructiveApprovalGate({
      approvalInbox: inbox,
      configDir,
      toolName: "computer_hotkey",
      resource: "computer:hotkey:alt+f4",
      args: { ...args, approval_request_id: request_id },
    });
    expect(retry.response).toBeNull();
    expect(retry.gate).not.toBeNull();
    if (retry.gate) {
      expect(() => consumeDestructiveApproval(inbox, retry.gate!)).not.toThrow();
    }
  });

  it("honors require_confirm_computer_use=false independently of require_confirm_destructive", () => {
    const configDir = makeConfigDir(`
agent:
  tools:
    require_confirm_destructive: true
    require_confirm_computer_use: false
`);
    const { inbox } = makeInbox();

    const computerUse = destructiveApprovalGate({
      approvalInbox: inbox,
      configDir,
      toolName: "computer_set_text",
      resource: "computer:set_text",
      args: { text: "hello" },
    });
    expect(computerUse.response).toBeNull();
    expect(computerUse.gate).toBeNull();

    const shell = destructiveApprovalGate({
      approvalInbox: inbox,
      configDir,
      toolName: "shell_execute",
      resource: "shell:rm -rf /tmp/x",
      args: { cmd: "rm -rf /tmp/x" },
    });
    expect(shell.response).not.toBeNull();
  });

  it("reads require_confirm_computer_use from the real nested agent.tools shape (regression guard for the config-path bug)", () => {
    // config/agent.yaml genuinely nests `tools:` under the top-level `agent:`
    // key. Before the fix, loadAgentToolsConfig() looked for `tools` at the
    // document root and always saw {}, so this flag could never actually be
    // turned off from the real file.
    const configDir = makeConfigDir(`
agent:
  name: Miki
  tools:
    require_confirm_computer_use: false
`);
    const { inbox } = makeInbox();
    const { gate, response } = destructiveApprovalGate({
      approvalInbox: inbox,
      configDir,
      toolName: "computer_launch",
      resource: "computer:launch:notepad.exe",
      args: { command: "notepad.exe" },
    });
    expect(response).toBeNull();
    expect(gate).toBeNull();
  });

  it("still classifies shell commands and gates shell_execute exactly as before", () => {
    expect(isDestructiveShellCommand("rm -rf /workspace/build")).toBe(true);
    expect(isDestructiveShellCommand("ls -la")).toBe(false);

    const configDir = makeConfigDir(DEFAULT_YAML);
    const { inbox } = makeInbox();
    const { response } = destructiveApprovalGate({
      approvalInbox: inbox,
      configDir,
      toolName: "file_delete",
      resource: "file:/workspace/notes.txt",
      args: { path: "/workspace/notes.txt" },
    });
    expect(response).not.toBeNull();
    expect(JSON.parse(response as string).tool).toBe("file_delete");
  });
});
