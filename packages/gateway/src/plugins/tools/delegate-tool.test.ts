import { describe, expect, it, afterEach } from "@jest/globals"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createTerminalTools, resolveCodingAgent } from "./terminal-tool.js"

describe("delegate_coding_agent", () => {
  const saved = { path: process.env.PATH, custom: process.env.MIKI_CODING_AGENT_COMMAND }
  afterEach(() => {
    process.env.PATH = saved.path
    if (saved.custom === undefined) delete process.env.MIKI_CODING_AGENT_COMMAND
    else process.env.MIKI_CODING_AGENT_COMMAND = saved.custom
  })

  it("is registered next to the terminal tools", () => {
    const names = createTerminalTools({ root: () => process.cwd(), restrictToWorkspace: () => false }).map((t) => t.name)
    expect(names).toContain("delegate_coding_agent")
  })

  it("reports a clear error when no coding agent is installed", () => {
    process.env.PATH = ""
    delete process.env.MIKI_CODING_AGENT_COMMAND
    const result = resolveCodingAgent()
    expect("error" in result && result.error).toMatch(/No coding agent CLI found/)
  })

  it("uses a custom command and passes the prompt through the environment", async () => {
    process.env.MIKI_CODING_AGENT_COMMAND = 'echo "$MIKI_DELEGATE_PROMPT"'
    const tool = createTerminalTools({ root: () => process.cwd(), restrictToWorkspace: () => false }).find((t) => t.name === "delegate_coding_agent")!
    const out = (await tool.execute({ prompt: "hello; touch /tmp/pwned" }, { runId: "r", signal: new AbortController().signal } as never)) as Record<string, unknown>
    expect(out.status).toBe("exited")
    expect(String(out.stdout)).toContain("hello; touch /tmp/pwned")
  })

  const fakeAgentOnPath = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "miki-bin-"))
    const bin = path.join(dir, "claude")
    writeFileSync(bin, "#!/bin/sh\n")
    chmodSync(bin, 0o755)
    process.env.PATH = dir
    delete process.env.MIKI_CODING_AGENT_COMMAND
  }

  it("on POSIX passes the prompt by environment variable only", () => {
    fakeAgentOnPath()
    const result = resolveCodingAgent("claude", "linux")
    expect("command" in result && result.command).toBe('claude -p "$MIKI_DELEGATE_PROMPT"')
    expect("promptFile" in result && result.promptFile).toBeFalsy()
  })

  it("on Windows never lets cmd.exe expand the prompt: it hands the agent a file name instead", () => {
    fakeAgentOnPath()
    const result = resolveCodingAgent("claude", "win32")
    if (!("command" in result)) throw new Error("expected a command")
    expect(result.command).not.toContain("MIKI_DELEGATE_PROMPT")
    expect(result.command).not.toContain("%")
    expect(result.promptFile).toMatch(/^\.miki-delegate-[0-9a-f]{16}\.txt$/)
    expect(result.command).toContain(result.promptFile as string)
  })

  it("ignores prototype keys as agent names", () => {
    fakeAgentOnPath()
    const result = resolveCodingAgent("constructor")
    expect("error" in result && result.error).toMatch(/not installed/)
  })
})
