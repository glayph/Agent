/**
 * Types for the identity workspace-files convention — OpenClaw's
 * SOUL/AGENTS/IDENTITY/USER/TOOLS bootstrap, adapted for Miki (step 01 of
 * the OpenClaw-style autonomy upgrade). See identity/README.md at the repo
 * root for the on-disk layout and rationale, including why this is called
 * "identity" here rather than "workspace" (that name is already taken by
 * workspaceDir/MIKI_WORKSPACE_DIR and by the separate workspace-folders
 * feature elsewhere in this codebase).
 */

export type IdentitySectionName =
  "SOUL" | "AGENTS_GLOBAL" | "AGENTS_ROLE" | "IDENTITY" | "USER" | "TOOLS";

export interface IdentitySection {
  name: IdentitySectionName;
  /** Absolute path this section was (or would be) read from. Empty string
   * for AGENTS_ROLE when no specialistId was given. */
  path: string;
  /** True when the file existed and was read successfully. */
  present: boolean;
  /** Trimmed file content. Empty string when not present. */
  content: string;
}

export interface IdentityLoadResult {
  /**
   * False when the identity directory itself does not exist yet — callers
   * should fall back to whatever they used before this convention existed
   * (in Miki's case, config/agent.yaml's agent.persona string). True once
   * the identity/ directory exists, even if individual files inside it are
   * still missing (those just yield empty, skipped sections).
   */
  usedIdentityFiles: boolean;
  /** All six sections, always in the documented load order, whether or not
   * each one was actually present — useful for tests and diagnostics. */
  sections: IdentitySection[];
  /** Section names in load order (SOUL -> AGENTS_GLOBAL -> AGENTS_ROLE ->
   * IDENTITY -> USER -> TOOLS). Constant; exposed for order-focused tests. */
  order: IdentitySectionName[];
  /** Present, non-empty sections concatenated in order, each under a
   * bracketed header, ready to use as a system-prompt prefix. Missing
   * sections are omitted entirely rather than left as empty headers. */
  assembled: string;
}
