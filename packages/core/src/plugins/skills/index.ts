export * from "./manager/index.js";
export {
  SkillInstaller,
  SkillRegistry,
  fetchSkill,
  validatePluginManifest as validateInstallerPluginManifest,
  downloadFile,
  downloadText,
  downloadJson,
  extractTarGz,
  findManifest,
} from "./installer/src/index.js";
export { SourceProtocol } from "./installer/src/index.js";
export type {
  ParsedSkillSpec,
  PluginManifest as InstallerPluginManifest,
  PluginContracts,
  PluginContract,
  PluginContractKind,
  PluginContractCatalogEntry,
  InstallOptions,
  InstallPreviewResult,
  InstallResult,
  PluginInstallability,
  VersionConflict,
  InstalledSkill,
  PluginDownloadResult,
  PluginValidationResult,
} from "./installer/src/index.js";
export { bundledSkillsRoot, BUNDLED_SKILLS_ROOT } from "./catalog/index.js";
