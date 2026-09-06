import * as fs from "fs";
import * as path from "path";

/**
 * Resolves the isolated directory a given (skill, language) runtime
 * environment lives in, and ensures it exists. Every language resolver gets
 * its own subdirectory here (a Python venv, a scoped node_modules, a cargo
 * target dir, etc.) — nothing is ever installed into the host's global
 * environment or the agent's own dependency tree.
 */
export class RuntimeSandboxPaths {
  private readonly rootDir: string;

  constructor(dataDir: string) {
    this.rootDir = path.join(dataDir, "runtime-sandboxes");
  }

  /** Root directory holding all sandboxes, e.g. <dataDir>/runtime-sandboxes */
  get root(): string {
    return this.rootDir;
  }

  /**
   * Directory for one skill+language combination, e.g.
   * <dataDir>/runtime-sandboxes/python-debugpy/python
   */
  forSkillLanguage(skillId: string, language: string): string {
    const safeSkill = this.sanitize(skillId);
    const safeLang = this.sanitize(language);
    return path.join(this.rootDir, safeSkill, safeLang);
  }

  ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Skill IDs can contain "/" (category/name); flatten to a safe dir name. */
  private sanitize(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "unknown";
  }
}
