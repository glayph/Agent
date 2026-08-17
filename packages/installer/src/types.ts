export enum SourceProtocol {
  CLAWHUB = "clawhub",
  NPM = "npm",
  LOCAL = "local",
  GIT = "git",
}

export interface ParsedSkillSpec {
  protocol: SourceProtocol;
  packageName: string;
  version?: string;
  branch?: string;
  registryUrl?: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  main?: string;
  permissions?: string[];
  contracts?: PluginContracts;
  plugin?: {
    entrypoint?: string;
    hooks?: Record<string, string>;
    dependencies?: Record<string, string>;
    permissions?: string[];
    contracts?: PluginContracts;
  };
}

export interface PluginContracts {
  tools?: PluginContract[];
  channels?: PluginContract[];
  skills?: PluginContract[];
  providers?: PluginContract[];
  hooks?: PluginContract[];
}

export type PluginContractKind = keyof PluginContracts;

export interface PluginContract {
  name: string;
  description?: string;
  entrypoint?: string;
  permissions?: string[];
  configSchema?: unknown;
  metadata?: Record<string, unknown>;
}

export interface InstallOptions {
  force?: boolean;
  version?: string;
  branch?: string;
}

export interface InstallResult {
  success: boolean;
  name: string;
  version: string;
  path: string;
  action: "installed" | "updated" | "skipped" | "failed";
  error?: string;
  entrypoint?: string;
  assetsPath?: string;
  description?: string;
  author?: string;
  license?: string;
  permissions?: string[];
  contracts?: PluginContracts;
  plugin?: PluginManifest["plugin"];
}

export interface VersionConflict {
  name: string;
  existingVersion: string;
  incomingVersion: string;
  resolution: "skip" | "force" | "abort";
}

export interface InstalledSkill {
  name: string;
  version: string;
  description: string;
  source: string;
  sourceProtocol: SourceProtocol;
  installedAt: string;
  path: string;
  entrypoint: string;
  assetsPath?: string;
  author?: string;
  license?: string;
  permissions?: string[];
  contracts?: PluginContracts;
  plugin?: PluginManifest["plugin"];
}

export interface PluginContractCatalogEntry {
  plugin: {
    name: string;
    version: string;
    installedAt: string;
    sourceProtocol: SourceProtocol;
    path: string;
    entrypoint: string;
    assetsPath?: string;
  };
  kind: PluginContractKind;
  contract: PluginContract;
  permissions: string[];
}

export interface PluginDownloadResult {
  manifest: PluginManifest;
  filesDir: string;
  entrypoint: string;
}

export interface PluginValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest: PluginManifest | null;
}

export interface RegistryState {
  version: number;
  skills: InstalledSkill[];
}
