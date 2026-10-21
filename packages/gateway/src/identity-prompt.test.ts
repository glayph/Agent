import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "@jest/globals"
import { buildIdentityContext } from "./identity-prompt.js"

describe("buildIdentityContext", () => {
  it("declares the agent identity and the live capabilities", () => {
    const text = buildIdentityContext({ groups: [{ key: "terminal", enabled: true }, { key: "browser", enabled: true }, { key: "web_search", enabled: false }] })
    expect(text).toMatch(/autonomous AI agent/)
    expect(text).toMatch(/terminal_run/)
    expect(text).toMatch(/browser_\*/)
    expect(text).toMatch(/CURRENTLY OFF[^\n]*web_search/)
  })
  it("includes the configured persona", () => {
    expect(buildIdentityContext({ groups: [], persona: "Speak Bengali." })).toMatch(/Speak Bengali\./)
  })
  it("loads TOOLS.md and the selected specialist's role instructions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "miki-identity-"))
    try {
      mkdirSync(path.join(root, "agents", "miki"), { recursive: true })
      writeFileSync(path.join(root, "TOOLS.md"), "Use terminal evidence.")
      writeFileSync(path.join(root, "agents", "miki", "AGENTS.md"), "Prefer direct execution.")
      const text = buildIdentityContext({ groups: [], identityDirs: [root], specialistId: "miki" })
      expect(text).toContain("Use terminal evidence.")
      expect(text).toContain("Prefer direct execution.")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
