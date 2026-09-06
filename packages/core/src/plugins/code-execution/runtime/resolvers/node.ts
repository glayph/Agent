import * as path from "path";
import * as fs from "fs";
import type {
  LanguageResolver,
  RuntimeCheckResult,
  RuntimeInstallResult,
  ShellRunner,
} from "../types.js";

/**
 * Node resolver: even though the agent core itself is TypeScript/Node, an
 * installed skill may declare an npm package it needs that the agent does
 * not bundle. This installs into an isolated per-skill node_modules (via
 * `npm install --prefix <sandbox>`) rather than the agent's own dependency
 * tree, so a skill's dependency never collides with or pollutes core.
 */
export class NodeResolver implements LanguageResolver {
  readonly language = "node";

  constructor(private shell: ShellRunner) {}

  async isRuntimeAvailable(): Promise<boolean> {
    const result = await this.shell.runShell("npm --version", undefined, 10);
    return result.exitCode === 0;
  }

  runtimeInstallHint(): string {
    return (
      "npm was not found on this system. Install Node.js from " +
      "https://nodejs.org (npm is bundled with it), then retry."
    );
  }

  async checkPackages(
    sandboxPath: string,
    packages: string[],
  ): Promise<RuntimeCheckResult> {
    const nodeModules = path.join(sandboxPath, "node_modules");
    if (!fs.existsSync(nodeModules)) {
      return {
        satisfied: false,
        sandboxReady: false,
        missingPackages: packages,
        detail: "Sandbox node_modules does not exist yet.",
      };
    }
    const missing = packages.filter((pkg) => {
      const name = this.stripVersionSpec(pkg);
      return !fs.existsSync(path.join(nodeModules, name));
    });
    return {
      satisfied: missing.length === 0,
      sandboxReady: true,
      missingPackages: missing,
    };
  }

  async install(
    sandboxPath: string,
    packages: string[],
  ): Promise<RuntimeInstallResult> {
    const available = await this.isRuntimeAvailable();
    if (!available) {
      return {
        success: false,
        installedPackages: [],
        error: "npm was not found on this system.",
        manualInstructions: this.runtimeInstallHint(),
      };
    }

    fs.mkdirSync(sandboxPath, { recursive: true });
    if (packages.length === 0) {
      return { success: true, sandboxPath, installedPackages: [] };
    }

    const pkgArgs = packages.map((p) => this.shellEscape(p)).join(" ");
    const command = `npm install --no-save --prefix "${sandboxPath}" ${pkgArgs}`;
    const result = await this.shell.runShell(command, sandboxPath, 300);

    if (result.exitCode !== 0) {
      return {
        success: false,
        installedPackages: [],
        error: `npm install failed: ${result.error || result.stderr}`,
        manualInstructions: `Manual fallback: \`${command}\``,
      };
    }

    return { success: true, sandboxPath, installedPackages: packages };
  }

  private stripVersionSpec(pkg: string): string {
    if (pkg.startsWith("@")) {
      const secondAt = pkg.indexOf("@", 1);
      return secondAt > 0 ? pkg.slice(0, secondAt) : pkg;
    }
    return pkg.split("@")[0].trim();
  }

  private shellEscape(value: string): string {
    if (/^[a-zA-Z0-9._@/-]+$/.test(value)) return value;
    throw new Error(`Refusing to install suspicious package spec: "${value}"`);
  }
}
