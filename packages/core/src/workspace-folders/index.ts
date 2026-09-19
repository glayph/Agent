export type {
  WorkspaceFolder,
  WorkspaceFoldersConfig,
  WorkspaceFolderRuleRef,
  FolderRulesPayload,
} from "./types.js";
export { DEFAULT_RULES_FILES, defaultWorkspaceFoldersConfig } from "./types.js";
export {
  loadWorkspaceFolders,
  saveWorkspaceFolders,
  listEnabledFolders,
  listIndexRoots,
  findFolderForPath,
  isPathRestrictedByDefault,
  addWorkspaceFolder,
  updateWorkspaceFolder,
  removeWorkspaceFolder,
  setIndexOnlyConfigured,
} from "./store.js";
export {
  memoryHasFolderRules,
  loadFolderRules,
  formatFolderRulesForPrompt,
  describeFolderPolicy,
} from "./rules.js";
