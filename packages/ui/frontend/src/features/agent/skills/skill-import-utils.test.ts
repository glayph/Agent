import { describe, expect, it } from "vitest"

import { MAX_SKILL_IMPORT_FILE_SIZE, validateSkillImportFile } from "./skill-import-utils"

describe("skill import file validation", () => {
  it.each(["guide.md", "skill.zip", "bundle.tar.gz"])("accepts %s files", (name) => {
    expect(validateSkillImportFile({ name, size: 1024 } as File)).toBeNull()
  })

  it("rejects unsupported file types", () => {
    expect(validateSkillImportFile({ name: "script.js", size: 10 } as File)).toBe("invalid_type")
  })

  it("uses the same 55 MiB limit as the backend", () => {
    expect(MAX_SKILL_IMPORT_FILE_SIZE).toBe(55 * 1024 * 1024)
    expect(validateSkillImportFile({ name: "bundle.zip", size: MAX_SKILL_IMPORT_FILE_SIZE })).toBeNull()
    expect(validateSkillImportFile({ name: "bundle.zip", size: MAX_SKILL_IMPORT_FILE_SIZE + 1 })).toBe("invalid_size")
  })
})
