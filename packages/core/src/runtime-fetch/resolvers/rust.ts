import * as path from "path";
import * as fs from "fs";
import type {
  LanguageResolver,
  RuntimeCheckResult,
  RuntimeInstallResult,
  ShellRunner,
} from "../types.js";

/**
 * Rust resolver: installs crates as binaries via `cargo install --root
 * <sandbox>`, scoped entirely to the sandbox directory. Intended for skills
 * that need a Rust-based CLI tool, not for compiling Rust libraries into the
 * agent itself (which never happens — core stays Go + TypeScript).
 */
export class RustResolver implements LanguageResolver {
  readonly language = "rust";

  constructor(private shell: ShellRunner) {}

  async isRuntimeAvailable(): Promise<boolean> {
    const result = await this.shell.runShell("cargo --version", undefined, 10);
    return result.exitCode === 0;
  }

  runtimeInstallHint(): string {
    return (
      "Rust/cargo was not found on this system. Install it via " +
      "https://rustup.rs (curl https://sh.rustup.rs -sSf | sh), then retry."
    );
  }

  async checkPackages(
    sandboxPath: string,
    packages: string[],
  ): Promise<RuntimeCheckResult> {
    const binDir = path.join(sandboxPath, "bin");
    if (!fs.existsSync(binDir)) {
      return {
        satisfied: false,
        sandboxReady: false,
        missingPackages: packages,
        detail: "Cargo sandbox bin directory does not exist yet.",
      };
    }
    const missing = packages.filter((pkg) => {
      const binName = this.stripVersionSpec(pkg);
      return !fs.existsSync(path.join(binDir, binName));
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
        error: "Rust/cargo was not found on this system.",
        manualInstructions: this.runtimeInstallHint(),
      };
    }

    fs.mkdirSync(sandboxPath, { recursive: true });
    if (packages.length === 0) {
      return { success: true, sandboxPath, installedPackages: [] };
    }

    const installed: string[] = [];
    for (const pkg of packages) {
      const crate = this.shellEscape(pkg);
      const command = `cargo install --root "${sandboxPath}" ${crate}`;
      const result = await this.shell.runShell(command, sandboxPath, 600);
      if (result.exitCode !== 0) {
        return {
          success: false,
          installedPackages: installed,
          error: `cargo install failed for "${pkg}": ${result.error || result.stderr}`,
          manualInstructions: `Manual fallback: \`${command}\``,
        };
      }
      installed.push(pkg);
    }

    return { success: true, sandboxPath, installedPackages: installed };
  }

  private stripVersionSpec(pkg: string): string {
    return pkg.split(/[@ ]/)[0].trim();
  }

  private shellEscape(value: string): string {
    if (/^[a-zA-Z0-9._@-]+$/.test(value)) return value;
    throw new Error(`Refusing to install suspicious package spec: "${value}"`);
  }
}
