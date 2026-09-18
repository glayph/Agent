import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentOrchestrator } from "../../agent.js";
import type { BrowserTool } from "../browser.js";
import type { ComputerAgent } from "../computer.js";
import type { CrawlerAgent } from "../crawler.js";
import type { ShellExecutor } from "../executor/shell.js";
import type { FileSecurityExecutor } from "../executor/file-security.js";
import type { RuntimeFetcher } from "../../runtime-fetch/index.js";
import type { RuntimePaths } from "../../paths.js";
import type { ApprovalInbox } from "../../security/approval-inbox.js";
import type { LauncherAdminController } from "../../api/launcher-compat.js";
import {
  destructiveApprovalGate,
  consumeDestructiveApproval,
} from "../executor/destructive-gate.js";
import type { SqlitePlatformConnectionStore } from "../../platform-connections.js";

export type ToolHandler = (
  args: Record<string, unknown>,
) => string | Promise<string>;

// NOTE ON SCOPE: Miki's callable tool surface is intentionally restricted to
// the computer_use family below (mouse, keyboard, screen, and computer
// vision — the agent's "hands, feet, and eyes") plus LLM text generation
// itself. Handlers for shell_execute, file_read/write/delete, browser DOM
// automation, scrape_*, web_search, model_*, runtime_ensure*, skill_*, and
// admin_* were removed here (and unregistered in
// tools/registry/executor.ts) so the agent can never invoke a
// preprogrammed/canned command in place of generating and executing its own
// action through computer_use. ToolHandlerContext below is left unchanged
// (still describing the full ToolRegistry shape) so it stays a safe `this`
// binding target and nothing else has to change.
export interface ToolHandlerContext {
  workspaceDir: string;
  runtimePaths: RuntimePaths;
  approvalInbox?: ApprovalInbox;
  adminController?: LauncherAdminController;
  executor: ShellExecutor;
  fileOps: FileSecurityExecutor;
  browser: BrowserTool;
  computer: ComputerAgent;
  crawler: CrawlerAgent;
  orchestrator?: AgentOrchestrator | null;
  runtimeFetcher?: RuntimeFetcher | null;
  platformConnectionStore?: SqlitePlatformConnectionStore | null;
}

// Mouse-free computer-use handlers
export async function handleComputerObserve(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.observe(args);
}

export async function handleComputerFocus(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.focus(args);
}

// AUDIT FIX: computer_invoke/set_text/hotkey/launch/clipboard(set|clear) can
// move the mouse, type, press hotkeys, or start/kill processes on the real
// desktop, but never consulted ApprovalInbox — unlike shell_execute/
// file_write/file_delete which were gated the same way before removal.
// Gate the state-changing computer-use actions; read-only ones (observe,
// focus, screenshot, scroll, list_*, get_system_info, verify, clipboard
// "get") are intentionally left ungated, matching how file_read was never
// gated.
export async function handleComputerInvoke(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const locator =
    (args["locator"] as string) ||
    (args["automation_id"] as string) ||
    (args["name"] as string) ||
    "";
  const { gate, response } = destructiveApprovalGate({
    approvalInbox: this.approvalInbox,
    configDir: this.runtimePaths.configDir,
    toolName: "computer_invoke",
    resource: `computer:invoke:${locator || "unspecified"}`,
    args,
  });
  if (response) return response;
  const result = await this.computer.invoke(args);
  if (gate) consumeDestructiveApproval(this.approvalInbox, gate);
  return result;
}

export async function handleComputerSetText(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const { gate, response } = destructiveApprovalGate({
    approvalInbox: this.approvalInbox,
    configDir: this.runtimePaths.configDir,
    toolName: "computer_set_text",
    resource: "computer:set_text",
    args,
  });
  if (response) return response;
  const result = await this.computer.setText(args);
  if (gate) consumeDestructiveApproval(this.approvalInbox, gate);
  return result;
}

export async function handleComputerHotkey(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const keys = (args["keys"] as string) || (args["key"] as string) || "";
  const { gate, response } = destructiveApprovalGate({
    approvalInbox: this.approvalInbox,
    configDir: this.runtimePaths.configDir,
    toolName: "computer_hotkey",
    resource: `computer:hotkey:${keys || "unspecified"}`,
    args,
  });
  if (response) return response;
  const result = await this.computer.hotkey(args);
  if (gate) consumeDestructiveApproval(this.approvalInbox, gate);
  return result;
}

export async function handleComputerClipboard(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const action = (args["action"] as string) || "get";
  // Reading the clipboard is not mutating; only set/clear need confirmation.
  if (action !== "set" && action !== "clear") {
    return await this.computer.clipboard(args);
  }
  const { gate, response } = destructiveApprovalGate({
    approvalInbox: this.approvalInbox,
    configDir: this.runtimePaths.configDir,
    toolName: "computer_clipboard",
    resource: `computer:clipboard:${action}`,
    args,
  });
  if (response) return response;
  const result = await this.computer.clipboard(args);
  if (gate) consumeDestructiveApproval(this.approvalInbox, gate);
  return result;
}

export async function handleComputerLaunch(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const command =
    (args["command"] as string) ||
    (args["app"] as string) ||
    (args["path"] as string) ||
    "";
  const { gate, response } = destructiveApprovalGate({
    approvalInbox: this.approvalInbox,
    configDir: this.runtimePaths.configDir,
    toolName: "computer_launch",
    resource: `computer:launch:${command || "unspecified"}`,
    args,
  });
  if (response) return response;
  const result = await this.computer.launch(args);
  if (gate) consumeDestructiveApproval(this.approvalInbox, gate);
  return result;
}

export async function handleComputerVerify(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.verify(args);
}

export async function handleComputerScreenshot(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.screenshot(args);
}

export async function handleComputerListProcesses(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.listProcesses(args);
}

export async function handleComputerGetSystemInfo(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.getSystemInfo(args);
}

export async function handleComputerListDisplays(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.listDisplays(args);
}

export async function handleComputerClickAt(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const x = args["x"];
  const y = args["y"];
  const { gate, response } = destructiveApprovalGate({
    approvalInbox: this.approvalInbox,
    configDir: this.runtimePaths.configDir,
    toolName: "computer_click_at",
    resource: `computer:click_at:${x},${y}`,
    args,
  });
  if (response) return response;
  const result = await this.computer.clickAt(args);
  if (gate) consumeDestructiveApproval(this.approvalInbox, gate);
  return result;
}

export async function handleComputerDrag(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const { gate, response } = destructiveApprovalGate({
    approvalInbox: this.approvalInbox,
    configDir: this.runtimePaths.configDir,
    toolName: "computer_drag",
    resource: "computer:drag",
    args,
  });
  if (response) return response;
  const result = await this.computer.drag(args);
  if (gate) consumeDestructiveApproval(this.approvalInbox, gate);
  return result;
}

export async function handleComputerScroll(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.scroll(args);
}

export async function handleComputerTerminateApp(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const target =
    (args["process_name"] as string) ||
    (args["processName"] as string) ||
    (args["app"] as string) ||
    (args["pid"] !== undefined ? String(args["pid"]) : "");
  const { gate, response } = destructiveApprovalGate({
    approvalInbox: this.approvalInbox,
    configDir: this.runtimePaths.configDir,
    toolName: "computer_terminate_app",
    resource: `computer:terminate_app:${target || "unspecified"}`,
    args,
  });
  if (response) return response;
  const result = await this.computer.terminateApp(args);
  if (gate) consumeDestructiveApproval(this.approvalInbox, gate);
  return result;
}

export async function handleComputerListWindows(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.listWindows(args);
}

export async function handleComputerGridScreenshot(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.screenshot({ ...args, grid: true });
}

export async function handleShellExecute(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const cmd = String(args["cmd"] || args["command"] || "").trim();
  if (!cmd) return "Error: cmd is required.";
  const cwd = args["working_dir"] ? String(args["working_dir"]) : undefined;
  const timeout = args["timeout"] != null ? Number(args["timeout"]) : undefined;
  const result = await this.executor.runShell(cmd, cwd, timeout);
  const parts = [
    result.stdout?.trim() && `stdout:\n${result.stdout.trim()}`,
    result.stderr?.trim() && `stderr:\n${result.stderr.trim()}`,
    `exitCode: ${result.exitCode}`,
    result.error && `error: ${result.error}`,
  ].filter(Boolean);
  return parts.join("\n");
}

export function handleFileRead(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): string {
  const filePath = String(args["path"] || args["file"] || "").trim();
  if (!filePath) return "Error: path is required.";
  return this.fileOps.readFile(filePath);
}

export function handleFileWrite(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): string {
  const filePath = String(args["path"] || args["file"] || "").trim();
  if (!filePath) return "Error: path is required.";
  return this.fileOps.writeFile(filePath, String(args["content"] ?? ""));
}

export function handleFileDelete(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): string {
  const filePath = String(args["path"] || args["file"] || "").trim();
  if (!filePath) return "Error: path is required.";
  return this.fileOps.deleteFile(filePath, Boolean(args["dryRun"]));
}

export function handleFileSearch(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): string {
  const query = String(args["query"] || args["text"] || "").trim();
  if (!query) return "Error: query is required.";
  const root = this.workspaceDir;
  const matches: string[] = [];
  const walk = (dir: string) => {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (["node_modules", ".git", "dist", "data"].includes(name)) continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile() && stat.size < 1_000_000) {
        try {
          if (fs.readFileSync(full, "utf8").includes(query)) {
            matches.push(path.relative(root, full));
          }
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(root);
  if (!matches.length) return `No matches for ${JSON.stringify(query)}.`;
  return `Found ${matches.length} file(s):\n${matches.slice(0, 20).join("\n")}`;
}
