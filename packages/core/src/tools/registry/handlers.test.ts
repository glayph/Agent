import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  handleShellExecute,
  handleComputerClickAt,
  handleComputerScroll,
  handleComputerClipboard,
  handleComputerLaunch,
} from "./handlers.js";
import { ApprovalInbox } from "../../security/approval-inbox.js";

describe("shell_execute handler input validation", () => {
  it("does not crash when the command argument is missing", async () => {
    const runShell = jest.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: -1,
      error: "shell_execute command is required.",
    });

    const result = await handleShellExecute.call(
      { executor: { runShell } } as never,
      {},
    );

    expect(runShell).toHaveBeenCalledWith("", undefined, 30);
    expect(result).toBe("Execution Error: shell_execute command is required.");
  });
});

describe("computer-use handlers — approval gating (audit fix)", () => {
  function makeContext() {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-handler-cfg-"));
    fs.writeFileSync(
      path.join(configDir, "agent.yaml"),
      "agent:\n  tools:\n    require_confirm_computer_use: true\n",
      "utf-8",
    );
    const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-handler-inbox-"));
    const approvalInbox = new ApprovalInbox(
      path.join(inboxDir, "approvals.json"),
    );
    const clickAt = jest.fn().mockResolvedValue("clicked");
    const scroll = jest.fn().mockResolvedValue("scrolled");
    const clipboard = jest.fn().mockResolvedValue("clipboard-ok");
    const launch = jest.fn().mockResolvedValue("launched");
    const ctx = {
      approvalInbox,
      runtimePaths: { configDir },
      computer: { clickAt, scroll, clipboard, launch },
    };
    return { ctx, clickAt, scroll, clipboard, launch, approvalInbox };
  }

  it("blocks computer_click_at until approved, then executes on retry", async () => {
    const { ctx, clickAt } = makeContext();

    const first = await handleComputerClickAt.call(ctx as never, {
      x: 10,
      y: 20,
    });
    expect(clickAt).not.toHaveBeenCalled();
    const { request_id } = JSON.parse(first);
    expect(typeof request_id).toBe("string");

    ctx.approvalInbox.approveByOperator(request_id, "owner");
    const second = await handleComputerClickAt.call(ctx as never, {
      x: 10,
      y: 20,
      approval_request_id: request_id,
    });
    expect(clickAt).toHaveBeenCalledTimes(1);
    expect(second).toBe("clicked");
  });

  it("does not gate computer_scroll (read-only/navigational)", async () => {
    const { ctx, scroll } = makeContext();
    const result = await handleComputerScroll.call(ctx as never, {
      delta_y: -100,
    });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(result).toBe("scrolled");
  });

  it("gates computer_clipboard only for set/clear, not get", async () => {
    const { ctx, clipboard } = makeContext();

    const readResult = await handleComputerClipboard.call(ctx as never, {
      action: "get",
    });
    expect(clipboard).toHaveBeenCalledTimes(1);
    expect(readResult).toBe("clipboard-ok");

    const setAttempt = await handleComputerClipboard.call(ctx as never, {
      action: "set",
      text: "secret",
    });
    expect(clipboard).toHaveBeenCalledTimes(1); // still 1 — the set call was blocked
    expect(JSON.parse(setAttempt).approval_required).toBe(true);
  });

  it("blocks computer_launch until approved", async () => {
    const { ctx, launch } = makeContext();
    const blocked = await handleComputerLaunch.call(ctx as never, {
      command: "cmd.exe",
    });
    expect(launch).not.toHaveBeenCalled();
    expect(JSON.parse(blocked).tool).toBe("computer_launch");
  });
});
