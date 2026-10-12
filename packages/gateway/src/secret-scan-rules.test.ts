import { describe, expect, it } from "@jest/globals"
import { isFixturePath, isIgnoredPath, isNonSecretValue, parseIgnoreFile, scanLine } from "./secret-scan-rules.js"

describe("scanLine", () => {
  it("ignores structural keys, references and placeholders", () => {
    for (const line of [
      "const apiKey = options.apiKey",
      "password: string",
      "token: process.env.GITHUB_TOKEN,",
      'const password = "changeme-changeme"',
      'api_key: "your_api_key_here"',
      'apiKey = "${GEMINI_API_KEY}"',
      'const secret = "GEMINI_API_KEY"',
    ]) expect(scanLine(line, "src/a.ts")).toBeUndefined()
  })
  it("flags real credential shapes", () => {
    expect(scanLine("const k = 'AIzaSyD-realkey_0123456789abcdefghijkl'", "src/a.ts")?.pattern).toBe("known-token")
    expect(scanLine("token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'", "src/a.ts")).toBeDefined()
    expect(scanLine('const password = "Xk29sLq0Zp44mNvB"', "src/a.ts")?.pattern).toBe("credential-assignment")
    expect(scanLine("-----BEGIN RSA PRIVATE KEY-----", "id.pem")?.pattern).toBe("private-key")
  })
  it("reads unquoted values only in env-style files", () => {
    expect(scanLine("OPENAI_API_KEY=Xk29sLq0Zp44mNvB77", ".env")).toBeDefined()
    expect(scanLine("OPENAI_API_KEY=Xk29sLq0Zp44mNvB77", "src/a.ts")).toBeUndefined()
    expect(scanLine("OPENAI_API_KEY=", ".env")).toBeUndefined()
  })
  it("never echoes the full secret", () => {
    const hit = scanLine("const password = 'Xk29sLq0Zp44mNvB'", "a.ts")
    expect(hit?.preview).not.toContain("Xk29sLq0Zp44mNvB")
  })
})

describe("isNonSecretValue", () => {
  it("treats words without digits as non-secret and mixed tokens as secret", () => {
    expect(isNonSecretValue("change-this-value")).toBe(true)
    expect(isNonSecretValue("Xk29sLq0Zp44mNvB")).toBe(false)
  })
})

describe("fixture and ignore handling", () => {
  it("recognises fixtures", () => {
    for (const p of [".env.example", "packages/core/src/a.test.ts", "packages/core/__tests__/x.ts", "docs/setup.md", "README.md", "pkg/x_test.go"]) expect(isFixturePath(p)).toBe(true)
    expect(isFixturePath("packages/gateway/src/index.ts")).toBe(false)
    expect(isFixturePath(".env")).toBe(false)
  })
  it("parses ignore globs and gitleaks fingerprints", () => {
    const m = parseIgnoreFile("# c\nscripts/**\nlegacy/old.ts:generic-api-key:12\n")
    expect(isIgnoredPath("scripts/a/b.mjs", m)).toBe(true)
    expect(isIgnoredPath("legacy/old.ts", m)).toBe(true)
    expect(isIgnoredPath("src/x.ts", m)).toBe(false)
  })
})
