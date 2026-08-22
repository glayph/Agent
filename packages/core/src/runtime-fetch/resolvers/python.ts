import * as path from "path";
import * as fs from "fs";
import type {
  LanguageResolver,
  RuntimeCheckResult,
  RuntimeInstallResult,
  ShellRunner,
} from "../types.js";

const PYTHON_CANDIDATES = ["python3", "python"];

/**
 * Python resolver: creates a per-skill virtualenv and installs packages via
 * pip from PyPI only. Never touches the host's global site-packages, never
 * uses sudo.
 */
export class PythonResolver implements LanguageResolver {
  readonly language = "python";

  constructor(private shell: ShellRunner) {}

  async isRuntimeAvailable(): Promise<boolean> {
    return (await this.findInterpreter()) !== null;
  }

  runtimeInstallHint(): string {
    return (
      "Python 3 was not found on this system. Install it from " +
      "https://www.python.org/downloads/ (or via your OS package manager, " +
      "e.g. 'apt install python3', 'brew install python3'), then retry."
    );
  }

  async checkPackages(
    sandboxPath: string,
    packages: string[],
  ): Promise<RuntimeCheckResult> {
    const venvPython = this.venvPythonPath(sandboxPath);
    if (!fs.existsSync(venvPython)) {
      return {
        satisfied: false,
        sandboxReady: false,
        missingPackages: packages,
        detail: "Sandbox virtualenv does not exist yet.",
      };
    }
    if (packages.length === 0) {
      return { satisfied: true, sandboxReady: true, missingPackages: [] };
    }

    // `pip show` per package is more reliable across pip versions than
    // parsing `pip list --format=json` output for import-name mismatches.
    const missing: string[] = [];
    for (const pkg of packages) {
      const name = this.stripVersionSpec(pkg);
      const result = await this.shell.runShell(
        `"${venvPython}" -m pip show ${this.shellEscape(name)}`,
        sandboxPath,
        30,
      );
      if (result.exitCode !== 0) missing.push(pkg);
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
    versionConstraint?: string,
  ): Promise<RuntimeInstallResult> {
    const interpreter = await this.findInterpreter();
    if (!interpreter) {
      return {
        success: false,
        installedPackages: [],
        error: "No Python 3 interpreter found on this system.",
        manualInstructions: this.runtimeInstallHint(),
      };
    }

    fs.mkdirSync(sandboxPath, { recursive: true });
    const venvPython = this.venvPythonPath(sandboxPath);

    if (!fs.existsSync(venvPython)) {
      const venvResult = await this.shell.runShell(
        `"${interpreter}" -m venv "${sandboxPath}"`,
        undefined,
        120,
      );
      if (venvResult.exitCode !== 0) {
        return {
          success: false,
          installedPackages: [],
          error: `Failed to create virtualenv: ${venvResult.error || venvResult.stderr}`,
          manualInstructions:
            `Manual fallback: run \`${interpreter} -m venv ${sandboxPath}\` ` +
            `then \`${sandboxPath}/bin/pip install ${packages.join(" ")}\` yourself.`,
        };
      }
    }

    if (packages.length === 0) {
      return { success: true, sandboxPath, installedPackages: [] };
    }

    const versionSuffix = versionConstraint
      ? ` (python ${versionConstraint} requested; not enforced by venv creation — verify manually if this matters)`
      : "";

    const pkgArgs = packages.map((p) => this.shellEscape(p)).join(" ");
    const installResult = await this.shell.runShell(
      `"${venvPython}" -m pip install --upgrade-strategy only-if-needed ${pkgArgs}`,
      sandboxPath,
      300,
    );

    if (installResult.exitCode !== 0) {
      return {
        success: false,
        installedPackages: [],
        error: `pip install failed${versionSuffix}: ${installResult.error || installResult.stderr}`,
        manualInstructions: `Manual fallback: \`${venvPython} -m pip install ${packages.join(" ")}\``,
      };
    }

    return {
      success: true,
      sandboxPath,
      installedPackages: packages,
    };
  }

  private venvPythonPath(sandboxPath: string): string {
    const bin =
      process.platform === "win32"
        ? path.join(sandboxPath, "Scripts", "python.exe")
        : path.join(sandboxPath, "bin", "python");
    return bin;
  }

  private async findInterpreter(): Promise<string | null> {
    for (const candidate of PYTHON_CANDIDATES) {
      const result = await this.shell.runShell(
        `${candidate} --version`,
        undefined,
        10,
      );
      if (result.exitCode === 0) return candidate;
    }
    return null;
  }

  private stripVersionSpec(pkg: string): string {
    return pkg.split(/[=<>!~]/)[0].trim();
  }

  /** Defensive shell-arg quoting; packages come from SKILL.md and should
   * already be simple names, but never trust that blindly. */
  private shellEscape(value: string): string {
    if (/^[a-zA-Z0-9._=<>!~+-]+$/.test(value)) return value;
    throw new Error(`Refusing to install suspicious package spec: "${value}"`);
  }
}
