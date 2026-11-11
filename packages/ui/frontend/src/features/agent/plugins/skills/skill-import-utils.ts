export const MAX_SKILL_IMPORT_FILE_SIZE = 55 * 1024 * 1024

export type SkillImportValidationError = "invalid_type" | "invalid_size"

/** Match the gateway's supported file types; MIME types alone are not reliable for dragged files. */
export function validateSkillImportFile(
  file: Pick<File, "name" | "size">,
): SkillImportValidationError | null {
  const fileName = file.name.toLowerCase()
  const supported =
    fileName.endsWith(".md") ||
    fileName.endsWith(".zip") ||
    fileName.endsWith(".tar.gz")

  if (!supported) return "invalid_type"
  if (file.size > MAX_SKILL_IMPORT_FILE_SIZE) return "invalid_size"
  return null
}
