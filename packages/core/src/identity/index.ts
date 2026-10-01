export type {
  IdentityLoadResult,
  IdentitySection,
  IdentitySectionName,
} from "./types.js";
export {
  SOUL_FILE,
  AGENTS_FILE,
  IDENTITY_FILE,
  USER_FILE,
  TOOLS_FILE,
  resolveIdentityPaths,
} from "./paths.js";
export type { IdentityFilePaths } from "./paths.js";
export { loadIdentityContext } from "./loader.js";
export { isSoulProtectedPath, SOUL_PROTECTED_MESSAGE } from "./guard.js";
export { proposeAgentsUpdate, proposeToolsUpdate } from "./propose-update.js";
export type { ProposeResult, ToolUpdateEntry } from "./propose-update.js";
