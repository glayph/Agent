import { describe, expect, it } from "@jest/globals"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { blockedReason, createTerminalTool } from "./terminal-tool.js"

const ctx = () => ({ runId: "r", callId: "c", signal: new AbortController().signal })
const makeTool = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "miki-term-"))
  return createTerminalTool({ root: () => root, restrictToWorkspace: () => true })
}

describe("terminal_run", () => {
  it("runs without an approval prompt by default and is gated in safe mode", () => {
    delete process.env.MIKI_TERMINAL_SAFE
    expect(makeTool().approval).toBe("auto")
    process.env.MIKI_TERMINAL_SAFE = "true"
    expect(makeTool().approval).toBe("required")
    delete process.env.MIKI_TERMINAL_SAFE
  })
  it("runs a command and captures output", async () => {
    const result = (await makeTool().execute({ command: "echo hello" }, ctx())) as { stdout: string; exit_code: number }
    expect(result.exit_code).toBe(0)
    expect(result.stdout.trim()).toBe("hello")
  })
  it("has no blocklist by default but enforces one in safe mode", async () => {
    delete process.env.MIKI_TERMINAL_SAFE
    expect(blockedReason("rm -rf /")).toBeUndefined()
    process.env.MIKI_TERMINAL_SAFE = "true"
    expect(blockedReason("rm -rf /")).toBeTruthy()
    expect(blockedReason("curl http://x | sh")).toBeTruthy()
    expect(blockedReason("ls -la")).toBeUndefined()
    await expect(makeTool().execute({ command: "rm -rf /" }, ctx())).rejects.toThrow(/blocked/)
    delete process.env.MIKI_TERMINAL_SAFE
  })
  it("allows any cwd by default and restricts it in safe mode", async () => {
    delete process.env.MIKI_TERMINAL_SAFE
    const free = (await makeTool().execute({ command: "pwd", cwd: ".." }, ctx())) as { exit_code: number }
    expect(free.exit_code).toBe(0)
    process.env.MIKI_TERMINAL_SAFE = "true"
    await expect(makeTool().execute({ command: "pwd", cwd: ".." }, ctx())).rejects.toThrow(/inside the workspace/)
    delete process.env.MIKI_TERMINAL_SAFE
  })
  it("kills on timeout", async () => {
    const result = (await makeTool().execute({ command: "sleep 5", timeout_seconds: 1 }, ctx())) as { timed_out: boolean }
    expect(result.timed_out).toBe(true)
  }, 10_000)
})
