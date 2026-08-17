import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import {
  InstalledSkill,
  InstallResult,
  PluginContract,
  PluginContractCatalogEntry,
  PluginContractKind,
  PluginContracts,
  VersionConflict,
  RegistryState,
  SourceProtocol,
} from "../types.js";

const REGISTRY_VERSION = 1;
const STATE_FILENAME = ".plugin-registry.json";
const SAFE_NAME_REGEX = /^[A-Za-z0-9_-]+$/;
const SOURCE_PROTOCOLS = new Set<string>(Object.values(SourceProtocol));
const CONTRACT_KINDS: PluginContractKind[] = [
  "tools",
  "channels",
  "skills",
  "providers",
  "hooks",
];

function isSafeName(name: string): boolean {
  return (
    name.trim() === name &&
    SAFE_NAME_REGEX.test(name) &&
    name !== "." &&
    name !== ".."
  );
}

function cloneSkill(skill: InstalledSkill): InstalledSkill {
  return JSON.parse(JSON.stringify(skill)) as InstalledSkill;
}

function cloneContract(contract: PluginContract): PluginContract {
  return JSON.parse(JSON.stringify(contract)) as PluginContract;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function isOptionalRecord(value: unknown): boolean {
  return value === undefined || isRecord(value);
}

function uniquePermissions(
  ...permissionLists: Array<string[] | undefined>
): string[] {
  const permissions = new Set<string>();
  for (const list of permissionLists) {
    for (const permission of list || []) {
      permissions.add(permission);
    }
  }
  return Array.from(permissions);
}

function isInstalledSkill(value: unknown): value is InstalledSkill {
  if (!value || typeof value !== "object") return false;

  const skill = value as Partial<InstalledSkill>;
  return (
    typeof skill.name === "string" &&
    isSafeName(skill.name) &&
    typeof skill.version === "string" &&
    skill.version.trim().length > 0 &&
    typeof skill.description === "string" &&
    typeof skill.source === "string" &&
    typeof skill.sourceProtocol === "string" &&
    SOURCE_PROTOCOLS.has(skill.sourceProtocol) &&
    typeof skill.installedAt === "string" &&
    !Number.isNaN(Date.parse(skill.installedAt)) &&
    typeof skill.path === "string" &&
    skill.path.trim().length > 0 &&
    typeof skill.entrypoint === "string" &&
    skill.entrypoint.trim().length > 0 &&
    (skill.assetsPath === undefined ||
      (typeof skill.assetsPath === "string" &&
        skill.assetsPath.trim().length > 0)) &&
    isOptionalStringArray(skill.permissions) &&
    isOptionalRecord(skill.contracts) &&
    isOptionalRecord(skill.plugin)
  );
}

export class SkillRegistry {
  getSkillsDir(): string {
    return this.skillsDir;
  }
  private statePath: string;
  private state: RegistryState;
  private loaded: boolean = false;
  private skillsDir: string;

  constructor(skillsDir: string, statePath?: string) {
    this.skillsDir = path.resolve(skillsDir);
    this.statePath = statePath || path.join(this.skillsDir, STATE_FILENAME);
    this.state = { version: REGISTRY_VERSION, skills: [] };
  }

  async init(): Promise<void> {
    await this.loadState();
  }

  private async loadState(): Promise<void> {
    try {
      const content = await fs.promises.readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(content) as RegistryState;
      if (parsed.version === REGISTRY_VERSION && Array.isArray(parsed.skills)) {
        this.state = {
          version: REGISTRY_VERSION,
          skills: parsed.skills.filter(isInstalledSkill).map(cloneSkill),
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[SkillRegistry] Failed to load state file, resetting:`,
          err,
        );
      }
      this.state = { version: REGISTRY_VERSION, skills: [] };
    }
    this.loaded = true;
  }

  private async saveState(): Promise<void> {
    const tmpPath = `${this.statePath}.tmp`;
    await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.promises.writeFile(tmpPath, JSON.stringify(this.state), "utf-8");
    try {
      await fs.promises.rename(tmpPath, this.statePath);
    } catch (err) {
      // Fallback for filesystems where rename may fail when target exists
      console.warn(`[SkillRegistry] rename failed, using copy fallback:`, err);
      await fs.promises.copyFile(tmpPath, this.statePath);
      await fs.promises.rm(tmpPath, { force: true });
    }
  }

  async listInstalled(): Promise<InstalledSkill[]> {
    if (!this.loaded) await this.loadState();
    return this.state.skills.map(cloneSkill);
  }

  async getSkill(name: string): Promise<InstalledSkill | null> {
    if (!this.loaded) await this.loadState();
    const skill = this.state.skills.find((s) => s.name === name);
    return skill ? cloneSkill(skill) : null;
  }

  async isInstalled(name: string): Promise<boolean> {
    const skill = await this.getSkill(name);
    return skill !== null;
  }

  async checkConflict(
    name: string,
    incomingVersion: string,
  ): Promise<VersionConflict | null> {
    const existing = await this.getSkill(name);
    if (!existing) return null;

    return {
      name,
      existingVersion: existing.version,
      incomingVersion,
      resolution: "skip", // allowed: "skip" | "overwrite" | "prompt"
    };
  }

  async register(result: InstallResult): Promise<void> {
    if (!this.loaded) await this.loadState();

    if (!isSafeName(result.name)) {
      throw new Error(
        `Invalid skill name "${result.name}": expected a safe file name`,
      );
    }
    if (typeof result.path !== "string" || result.path.trim().length === 0) {
      throw new Error(`Invalid install path for skill "${result.name}"`);
    }

    const existingIdx = this.state.skills.findIndex(
      (s) => s.name === result.name,
    );

    const now = new Date().toISOString();
    const sourceProtocol = this.inferProtocol(result.path);
    const existing =
      existingIdx >= 0 ? this.state.skills[existingIdx] : undefined;

    const skill: InstalledSkill = {
      name: result.name,
      version: result.version,
      description: result.description || existing?.description || "",
      source: result.path,
      sourceProtocol,
      installedAt: existing?.installedAt || now,
      path: result.path,
      entrypoint: result.entrypoint || `${result.name}.ts`,
      assetsPath: result.assetsPath || existing?.assetsPath,
      author: result.author || existing?.author,
      license: result.license || existing?.license,
      permissions: result.permissions || existing?.permissions,
      contracts: result.contracts || existing?.contracts,
      plugin: result.plugin || existing?.plugin,
    };

    if (existingIdx >= 0) {
      this.state.skills[existingIdx] = skill;
    } else {
      this.state.skills.push(skill);
    }

    await this.saveState();
  }

  async listPluginContracts(
    kind?: PluginContractKind,
  ): Promise<PluginContractCatalogEntry[]> {
    if (!this.loaded) await this.loadState();

    const kinds = kind ? [kind] : CONTRACT_KINDS;
    const entries: PluginContractCatalogEntry[] = [];

    for (const skill of this.state.skills) {
      this.collectContractEntries(entries, skill, skill.contracts, kinds);
      this.collectContractEntries(
        entries,
        skill,
        skill.plugin?.contracts,
        kinds,
        skill.plugin?.permissions,
      );
    }

    return entries;
  }

  async remove(name: string): Promise<boolean> {
    if (!this.loaded) await this.loadState();

    const initialLength = this.state.skills.length;
    this.state.skills = this.state.skills.filter((s) => s.name !== name);

    if (this.state.skills.length !== initialLength) {
      await this.saveState();
      return true;
    }
    return false;
  }

  async installAndLoad(
    result: InstallResult,
    apiBaseUrl?: string,
  ): Promise<void> {
    await this.register(result);

    if (apiBaseUrl) {
      try {
        const base = apiBaseUrl.replace(/\/+$/, "");
        const url = new URL(`${base}/skills/reload`);
        const options = {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          timeout: 5000,
        };

        await new Promise<void>((resolve, reject) => {
          const req = http.request(options, (res) => {
            res.resume();
            resolve();
          });
          req.on("error", reject);
          req.on("timeout", () => {
            req.destroy();
            reject(new Error("Timeout"));
          });
          req.end();
        });
      } catch (err) {
        console.warn(`[SkillRegistry] Failed to reload core skills:`, err);
      }
    }
  }

  private collectContractEntries(
    entries: PluginContractCatalogEntry[],
    skill: InstalledSkill,
    contracts: PluginContracts | undefined,
    kinds: PluginContractKind[],
    pluginPermissions?: string[],
  ): void {
    if (!contracts) return;

    for (const kind of kinds) {
      const contractsForKind = contracts[kind] || [];
      for (const contract of contractsForKind) {
        entries.push({
          plugin: {
            name: skill.name,
            version: skill.version,
            installedAt: skill.installedAt,
            sourceProtocol: skill.sourceProtocol,
            path: skill.path,
            entrypoint: skill.entrypoint,
            assetsPath: skill.assetsPath,
          },
          kind,
          contract: cloneContract(contract),
          permissions: uniquePermissions(
            skill.permissions,
            pluginPermissions,
            contract.permissions,
          ),
        });
      }
    }
  }

  private inferProtocol(sourcePath: string): SourceProtocol {
    if (sourcePath.startsWith("clawhub:")) return SourceProtocol.CLAWHUB;
    if (sourcePath.startsWith("npm:")) return SourceProtocol.NPM;
    if (sourcePath.startsWith("git:")) return SourceProtocol.GIT;
    return SourceProtocol.LOCAL;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// EXTENSION POINT — Adding a custom registry backend
// ═══════════════════════════════════════════════════════════════════════
// Subclass SkillRegistry and override saveState/loadState to persist
// to a database (SQLite, PostgreSQL) or a remote API endpoint.
// ═══════════════════════════════════════════════════════════════════════
