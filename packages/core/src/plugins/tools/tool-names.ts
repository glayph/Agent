import { createHash } from "node:crypto";

/**
 * Convert an arbitrary extension identity into a stable, model-safe tool name.
 * The digest is based on the original identity (not the sanitized value), so
 * punctuation changes and truncation cannot silently merge distinct plugins.
 */
export function stableToolName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${normalized.slice(0, 51)}_${suffix}`;
}
