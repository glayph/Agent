import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApprovalInbox } from "../../security/approval-inbox.js";
import {
  destructiveApprovalGate,
  requireConfirmDestructive,
  requireConfirmComputerUse,
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

// These read agent.yaml directly and don't go through destructiveApprovalGate,
// so they stay meaningful regardless of runtime mode -- unlike
// destructiveApprovalGate itself, this parsing isn't short-circuited by
// turbo mode. Kept from before the standard-mode removal since the
// nested-agent.tools-shape bug they guard against is unrelated to it.
describe("requireConfirmDestructive / requireConfirmComputerUse (config parsing)", () => {
  it("default to true when unset", () => {
    const configDir = makeConfigDir("agent:\n  name: Miki\n");
    expect(requireConfirmDestructive(configDir)).toBe(true);
    expect(requireConfirmComputerUse(configDir)).toBe(true);
  });

  it("honors require_confirm_computer_use=false independently of require_confirm_destructive", () => {
    const configDir = makeConfigDir(`
agent:
  tools:
    require_confirm_destructive: true
    require_confirm_computer_use: false
`);
    expect(requireConfirmDestructive(configDir)).toBe(true);
    expect(requireConfirmComputerUse(configDir)).toBe(false);
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
    expect(requireConfirmComputerUse(configDir)).toBe(false);
  });

  it("still classifies destructive shell commands the same way", () => {
    expect(isDestructiveShellCommand("rm -rf /workspace/build")).toBe(true);
    expect(isDestructiveShellCommand("ls -la")).toBe(false);
  });
});

// Turbo mode has been the sole, permanent runtime mode since standard mode
// was removed (owner-requested): destructiveApprovalGate() checks
// isTurboModeActive() first and, whenever it's true, bypasses everything
// below unconditionally -- the require_confirm_destructive/
// require_confirm_computer_use checks above are still parsed correctly (see
// the describe block above) but destructiveApprovalGate() itself never
// reaches them anymore, for any tool, under any config. There is no
// remaining chat command or config value that restores the old blocking
// behavior; only reverting this code change would.
describe("destructiveApprovalGate — turbo mode bypasses it unconditionally", () => {
  it("auto-approves computer_click_at even with require_confirm_computer_use: true", () => {
    const configDir = makeConfigDir(DEFAULT_YAML);
    const { inbox } = makeInbox();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const { gate, response } = destructiveApprovalGate({
      approvalInbox: inbox,
      configDir,
      toolName: "computer_click_at",
      resource: "computer:click_at:100,200",
      args: { x: 100, y: 200 },
    });
    expect(gate).toBeNull();
    expect(response).toBeNull(); // no approval_required round-trip anymore
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("TURBO MODE"),
    );
    warn.mockRestore();
  });

  it("auto-approves shell_execute even with require_confirm_destructive: true and no approvalInbox wired up", () => {
    const configDir = makeConfigDir(DEFAULT_YAML);
    const { gate, response } = destructiveApprovalGate({
      approvalInbox: undefined,
      configDir,
      toolName: "shell_execute",
      resource: "shell:rm -rf /tmp/x",
      args: { cmd: "rm -rf /tmp/x" },
    });
    // Before turbo mode was permanent, missing approvalInbox + gateEnabled
    // would throw here. Turbo's check runs first, so it never gets that far.
    expect(gate).toBeNull();
    expect(response).toBeNull();
  });

  it("bypasses file_delete regardless of require_confirm_destructive: false too (turbo doesn't care either way)", () => {
    const configDir = makeConfigDir(`
agent:
  tools:
    require_confirm_destructive: false
`);
    const { inbox } = makeInbox();
    const { gate, response } = destructiveApprovalGate({
      approvalInbox: inbox,
      configDir,
      toolName: "file_delete",
      resource: "file:/workspace/notes.txt",
      args: { path: "/workspace/notes.txt" },
    });
    expect(gate).toBeNull();
    expect(response).toBeNull();
  });
});
