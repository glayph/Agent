import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import {
  SourceProtocol,
  ParsedSkillSpec,
  InstallOptions,
  InstallResult,
  InstalledSkill,
  PluginManifest,
} from "../types.js";
import { fetchSkill } from "../source-dispatch.js";
import { validatePluginManifest } from "../utils/validator.js";
import { SkillRegistry } from "../registry/skill-registry.js";

export class SkillInstaller {
  private registry: SkillRegistry;
  private skillsDir: string;
  private clawhubRegistryUrl: string;

  constructor(
    skillsDir: string,
    options?: {
      registry?: SkillRegistry;
      clawhubRegistryUrl?: string;
    },
  ) {
    this.skillsDir = path.resolve(skillsDir);
    this.clawhubRegistryUrl =
      options?.clawhubRegistryUrl || process.env["CLAWHUB_REGISTRY"] || "";
    this.registry = options?.registry || new SkillRegistry(this.skillsDir);
  }

  async init(): Promise<void> {
    await this.registry.init();
    await fs.promises.mkdir(this.skillsDir, { recursive: true });
  }

  async install(
    skillSpec: string,
    options?: InstallOptions,
  ): Promise<InstallResult> {
    const opts: InstallOptions = { force: false, ...options };

    try {
      const parsed = this.parseSpec(skillSpec);

      const conflict = await this.registry.checkConflict(
        parsed.packageName,
        parsed.version || "0.0.0",
      );

      if (conflict && !opts.force) {
        return {
          success: false,
          name: conflict.name,
          version: conflict.incomingVersion,
          path: "",
          action: "skipped",
          error: `Version conflict: ${conflict.name}@${conflict.existingVersion} already installed (use --force to override)`,
        };
      }

      const tmpDir = path.join(
        os.tmpdir(),
        `plugin-install-${parsed.packageName.replace(/[^a-zA-Z0-9_-]/g, "_")}-${randomUUID()}`,
      );
      await fs.promises.mkdir(tmpDir, { recursive: true });

      let result: InstallResult;

      try {
        const downloadResult = await fetchSkill(
          parsed.protocol, parsed, tmpDir,
          { clawhubRegistryUrl: this.clawhubRegistryUrl || undefined },
        );

        const validation = await validatePluginManifest(
          downloadResult.manifest,
          downloadResult.filesDir,
        );
        if (!validation.valid) {
          return {
            success: false,
            name: downloadResult.manifest.name || parsed.packageName,
            version: downloadResult.manifest.version || "0.0.0",
            path: "",
            action: "failed",
            error: `Validation failed: ${validation.errors.join("; ")}`,
          };
        }

        const manifest = validation.manifest!;
        const skillTsPath = path.join(this.skillsDir, `${manifest.name}.ts`);
        const assetsDir = path.join(this.skillsDir, `${manifest.name}_assets`);
        const existingVersion = await this.getExistingVersion(manifest.name);
        const action: InstallResult["action"] = existingVersion
          ? opts.force
            ? "updated"
            : "skipped"
          : "installed";

        if (action === "skipped") {
          return {
            success: false,
            name: manifest.name,
            version: manifest.version,
            path: skillTsPath,
            action: "skipped",
            error: `Already installed (version ${existingVersion})`,
          };
        }

        await fs.promises.writeFile(skillTsPath, `// Plugin: ${manifest.name} v${manifest.version}\nexport const DESCRIPTION = \`${manifest.description}\`;\n`, "utf-8");

        if (fs.existsSync(assetsDir)) {
          await fs.promises.rm(assetsDir, { recursive: true, force: true });
        }
        await fs.promises.cp(downloadResult.filesDir, assetsDir, {
          recursive: true,
          force: true,
        });

        result = {
          success: true,
          name: manifest.name,
          version: manifest.version,
          path: skillTsPath,
          action,
          entrypoint: downloadResult.entrypoint,
          assetsPath: assetsDir,
          description: manifest.description,
          author: manifest.author,
          license: manifest.license,
          permissions: manifest.permissions,
          contracts: manifest.contracts,
          plugin: manifest.plugin,
        };

        await this.registry.installAndLoad(result);
      } finally {
        try {
          await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch {
          // tmpDir cleanup is best-effort; outer catch handles install failures
        }
      }

      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const parsedName = this.safeParseName(skillSpec);
      return {
        success: false,
        name: parsedName,
        version: options?.version || "0.0.0",
        path: "",
        action: "failed",
        error: errorMessage,
      };
    }
  }

  getRegistry(): SkillRegistry {
    return this.registry;
  }

  private async getExistingVersion(name: string): Promise<string | null> {
    const installed = await this.registry.getSkill(name);
    return installed?.version || null;
  }

  parseSpec(spec: string): ParsedSkillSpec {
    const trimmed = spec.trim();
    if (!trimmed || trimmed.length > 4096) {
      throw new Error(
        `Invalid skill spec: empty or too long (${trimmed.length} chars)`,
      );
    }

    const clawhubMatch = trimmed.match(/^clawhub:(.+)/);
    if (clawhubMatch) {
      return { protocol: SourceProtocol.CLAWHUB, packageName: clawhubMatch[1] };
    }

    const npmMatch = trimmed.match(/^npm:(.+)/);
    if (npmMatch) {
      const rest = npmMatch[1];
      if (rest.startsWith("@")) {
        const slashIndex = rest.indexOf("/");
        if (slashIndex > 0) {
          const afterScope = rest.slice(slashIndex + 1);
          const atIndex = afterScope.lastIndexOf("@");
          if (atIndex > 0) {
            const scopePrefix = rest.slice(0, slashIndex + 1);
            return {
              protocol: SourceProtocol.NPM,
              packageName: scopePrefix + afterScope.slice(0, atIndex),
              version: afterScope.slice(atIndex + 1),
            };
          }
        }
        return { protocol: SourceProtocol.NPM, packageName: rest };
      }
      const atIndex = rest.lastIndexOf("@");
      if (atIndex > 0) {
        return {
          protocol: SourceProtocol.NPM,
          packageName: rest.slice(0, atIndex),
          version: rest.slice(atIndex + 1),
        };
      }
      return { protocol: SourceProtocol.NPM, packageName: rest };
    }

    const gitMatch = trimmed.match(/^git:(.+?)(?:#(.+))?$/);
    if (gitMatch) {
      return {
        protocol: SourceProtocol.GIT,
        packageName: gitMatch[1],
        branch: gitMatch[2] || undefined,
      };
    }

    if (
      trimmed.startsWith("./") ||
      trimmed.startsWith(".\\") ||
      trimmed.startsWith("/") ||
      /^[A-Z]:\\/i.test(trimmed)
    ) {
      return { protocol: SourceProtocol.LOCAL, packageName: trimmed };
    }

    // Fallback: treat as local path or package name
    return { protocol: SourceProtocol.LOCAL, packageName: trimmed };
  }

  async listInstalled(): Promise<InstalledSkill[]> {
    return this.registry.listInstalled();
  }

  async uninstall(name: string): Promise<boolean> {
    const skill = await this.registry.getSkill(name);
    if (!skill) return false;

    const skillTsPath = path.join(this.skillsDir, `${name}.ts`);
    const assetsDir = path.join(this.skillsDir, `${name}_assets`);

    try {
      await fs.promises.rm(skillTsPath, { force: true });
    } catch {
      // best-effort
    }
    try {
      await fs.promises.rm(assetsDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }

    return this.registry.remove(name);
  }

  private safeParseName(spec: string): string {
    try {
      return this.parseSpec(spec).packageName;
    } catch {
      return spec;
    }
  }
}
