import * as fs from "fs";
import type {
  LanguageResolver,
  RuntimeCheckResult,
  RuntimeInstallResult,
  ShellRunner,
} from "../types.js";

/**
 * Ruby resolver: installs gems into a per-skill GEM_HOME directory (via
 * `gem install --install-dir`), never system-wide, never sudo.
 */
export class RubyResolver implements LanguageResolver {
  readonly language = "ruby";

  constructor(private shell: ShellRunner) {}

  async isRuntimeAvailable(): Promise<boolean> {
    const result = await this.shell.runShell("ruby --version", undefined, 10);
    return result.exitCode === 0;
  }

  runtimeInstallHint(): string {
    return (
      "Ruby was not found on this system. Install it via your OS package " +
      "manager (e.g. 'apt install ruby-full', 'brew install ruby') or " +
      "https://www.ruby-lang.org/en/documentation/installation/, then retry."
    );
  }

  async checkPackages(
    sandboxPath: string,
    packages: string[],
  ): Promise<RuntimeCheckResult> {
    if (!fs.existsSync(sandboxPath)) {
      return {
        satisfied: false,
        sandboxReady: false,
        missingPackages: packages,
        detail: "Gem sandbox directory does not exist yet.",
      };
    }
    if (packages.length === 0) {
      return { satisfied: true, sandboxReady: true, missingPackages: [] };
    }
    const missing: string[] = [];
    for (const pkg of packages) {
      const name = this.stripVersionSpec(pkg);
      const result = await this.shell.runShell(
        `gem list -i "${this.shellEscape(name)}"`,
        sandboxPath,
        30,
      );
      // `gem list -i` exits 0 either way; it prints "true"/"false".
      if (!result.stdout.trim().toLowerCase().startsWith("true")) {
        missing.push(pkg);
      }
    }
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
        error: "Ruby was not found on this system.",
        manualInstructions: this.runtimeInstallHint(),
      };
    }

    fs.mkdirSync(sandboxPath, { recursive: true });
    if (packages.length === 0) {
      return { success: true, sandboxPath, installedPackages: [] };
    }

    const gemHome = sandboxPath;
    const pkgArgs = packages.map((p) => this.shellEscape(p)).join(" ");
    // GEM_HOME scopes the install to this sandbox directory only.
    const command = `GEM_HOME="${gemHome}" GEM_PATH="${gemHome}" gem install --no-document --install-dir "${gemHome}" ${pkgArgs}`;
    const result = await this.shell.runShell(command, sandboxPath, 300);

    if (result.exitCode !== 0) {
      return {
        success: false,
        installedPackages: [],
        error: `gem install failed: ${result.error || result.stderr}`,
        manualInstructions: `Manual fallback: \`${command}\``,
      };
    }

    return { success: true, sandboxPath, installedPackages: packages };
  }

  private stripVersionSpec(pkg: string): string {
    return pkg.split(/[=<>!~ ]/)[0].trim();
  }

  private shellEscape(value: string): string {
    if (/^[a-zA-Z0-9._=<>!~+-]+$/.test(value)) return value;
    throw new Error(`Refusing to install suspicious package spec: "${value}"`);
  }
}
