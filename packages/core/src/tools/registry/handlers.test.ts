import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  handleComputerClickAt,
  handleComputerScroll,
  handleComputerClipboard,
  handleComputerLaunch,
} from "./handlers.js";
import { ApprovalInbox } from "../../security/approval-inbox.js";

describe("computer-use handlers — approval gating (audit fix)", () => {
  function makeContext() {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-handler-cfg-"),
    );
    fs.writeFileSync(
      path.join(configDir, "agent.yaml"),
      "agent:\n  tools:\n    require_confirm_computer_use: true\n",
      "utf-8",
    );
    const inboxDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-handler-inbox-"),
    );
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

  // Turbo mode has been the sole, permanent runtime mode since standard mode
  // was removed (owner-requested), and destructiveApprovalGate() bypasses
  // require_confirm_computer_use unconditionally whenever it's active (see
  // destructive-gate.ts) — so these config-gated tools now execute
  // immediately, with only a console.warn audit trail, regardless of what
  // agent.yaml says. There is no longer a config value or chat command that
  // restores the old blocking behavior.

  it("turbo mode auto-approves computer_click_at immediately (no approval round-trip)", async () => {
    const { ctx, clickAt } = makeContext();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = await handleComputerClickAt.call(ctx as never, {
      x: 10,
      y: 20,
    });
    expect(clickAt).toHaveBeenCalledTimes(1);
    expect(clickAt).toHaveBeenCalledWith({ x: 10, y: 20 });
    expect(result).toBe("clicked");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("TURBO MODE"),
    );
    warn.mockRestore();
  });

  it("does not gate computer_scroll (read-only/navigational)", async () => {
    const { ctx, scroll } = makeContext();
    const result = await handleComputerScroll.call(ctx as never, {
      delta_y: -100,
    });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(result).toBe("scrolled");
  });

  it("turbo mode auto-approves computer_clipboard set/clear too, same as get", async () => {
    const { ctx, clipboard } = makeContext();

    const readResult = await handleComputerClipboard.call(ctx as never, {
      action: "get",
    });
    expect(clipboard).toHaveBeenCalledTimes(1);
    expect(readResult).toBe("clipboard-ok");

    const setResult = await handleComputerClipboard.call(ctx as never, {
      action: "set",
      text: "secret",
    });
    // Turbo bypasses the set/clear gate too — this now runs immediately,
    // just like the read above did.
    expect(clipboard).toHaveBeenCalledTimes(2);
    expect(setResult).toBe("clipboard-ok");
  });

  it("turbo mode auto-approves computer_launch immediately", async () => {
    const { ctx, launch } = makeContext();
    const result = await handleComputerLaunch.call(ctx as never, {
      command: "cmd.exe",
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(result).toBe("launched");
  });
});
