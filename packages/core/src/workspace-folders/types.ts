/**
 * User-managed workspace folders for Miki.
 * Agent has full system access, but indexing + default work scope
 * are limited to folders the user adds in Settings (unless the user
 * explicitly asks to work outside them).
 */

export interface WorkspaceFolderRuleRef {
  /** Relative path inside the folder, e.g. ".gitignore", "rule.md", ".miki/rules.md" */
  path: string;
}

export interface WorkspaceFolder {
  /** Stable id (uuid or slug) */
  id: string;
  /** Absolute path on disk */
  path: string;
  /** Display label in UI / Drive tree */
  label: string;
  /** Whether this entry is active */
  enabled: boolean;
  /** Include in system index / finder */
  index: boolean;
  /**
   * If true, agent should not proactively work or index inside this folder
   * unless the user explicitly requests a task there.
   */
  restrictDefault: boolean;
  /**
   * Rule files the agent should read when working inside this folder
   * (unless memory already holds rules for this folder).
   */
  rulesFiles: string[];
  /** Optional free-form notes shown in Settings */
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceFoldersConfig {
  schemaVersion: 1;
  /**
   * When true (default), only user-added folders (with index:true) plus
   * Miki private space are indexed. Full disk is still accessible via tools
   * when the user asks.
   */
  indexOnlyConfigured: boolean;
  folders: WorkspaceFolder[];
}

export interface FolderRulesPayload {
  folderId: string;
  folderPath: string;
  /** True when long-term memory already has rules for this folder */
  skippedDueToMemory: boolean;
  rules: Array<{ file: string; content: string }>;
}

export const DEFAULT_RULES_FILES = [
  ".gitignore",
  "rule.md",
  "RULES.md",
  ".miki/rules.md",
  ".miki/RULES.md",
];

export function defaultWorkspaceFoldersConfig(): WorkspaceFoldersConfig {
  return {
    schemaVersion: 1,
    indexOnlyConfigured: true,
    folders: [],
  };
}
