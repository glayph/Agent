import Database from "better-sqlite3";
import * as path from "path";
import { RuntimeInstallConsentStore } from "./consent-store.js";
import { RuntimeSandboxPaths } from "./sandbox.js";
import { PythonResolver } from "./resolvers/python.js";
import { RubyResolver } from "./resolvers/ruby.js";
import { RustResolver } from "./resolvers/rust.js";
import { NodeResolver } from "./resolvers/node.js";
import type {
  LanguageResolver,
  RuntimeRequirement,
  ShellRunner,
} from "./types.js";

export type {
  RuntimeRequirement,
  RuntimeInstallRequest,
  RuntimeInstallStatus,
  RuntimeCheckResult,
  RuntimeInstallResult,
  LanguageResolver,
  ShellRunner,
} from "./types.js";
export { RuntimeInstallConsentStore } from "./consent-store.js";
export { RuntimeSandboxPaths } from "./sandbox.js";

export type EnsureRuntimeOutcome =
  | { outcome: "already-satisfied" }
  | { outcome: "awaiting-consent"; requestId: string }
  | { outcome: "denied"; requestId: string }
  | { outcome: "installed"; sandboxPath: string }
  | { outcome: "failed"; error: string; manualInstructions?: string }
  | { outcome: "unsupported-language"; language: string }
  | { outcome: "runtime-unavailable"; language: string; hint: string };

/**
 * Central orchestrator for the multi-language runtime fetcher. A single
 * instance is shared per agent process; `ensureRuntimeReady` is the one
 * entry point skill-loading code needs to call before actually running a
 * skill that declared `runtime` requirements in its SKILL.md.
 */
export class RuntimeFetcher {
  private resolvers: Map<string, LanguageResolver> = new Map();
  private consentStore: RuntimeInstallConsentStore;
  private sandboxPaths: RuntimeSandboxPaths;
  private allowedLanguages: Set<string>;
  private approvalLevel:
    "REQUIRE_APPROVAL" | "TRUSTED_FULL_ACCESS" | "DISABLED";

  constructor(options: {
    dataDir: string;
    shell: ShellRunner;
    allowedLanguages?: string[];
    approvalLevel?: "REQUIRE_APPROVAL" | "TRUSTED_FULL_ACCESS" | "DISABLED";
    db?: Database.Database;
  }) {
    const db =
      options.db ??
      new Database(path.join(options.dataDir, "runtime-installer.sqlite"));
    this.consentStore = new RuntimeInstallConsentStore(db);
    this.sandboxPaths = new RuntimeSandboxPaths(options.dataDir);
    this.allowedLanguages = new Set(
      (options.allowedLanguages ?? ["python", "ruby", "rust", "node"]).map(
        (l) => l.toLowerCase(),
      ),
    );
    this.approvalLevel = options.approvalLevel ?? "REQUIRE_APPROVAL";

    this.registerResolver(new PythonResolver(options.shell));
    this.registerResolver(new RubyResolver(options.shell));
    this.registerResolver(new RustResolver(options.shell));
    this.registerResolver(new NodeResolver(options.shell));
  }

  registerResolver(resolver: LanguageResolver): void {
    this.resolvers.set(resolver.language.toLowerCase(), resolver);
  }

  getConsentStore(): RuntimeInstallConsentStore {
    return this.consentStore;
  }

  /**
   * Ensure one runtime requirement is available, creating a consent request
   * if this is a new (skill, language, packages) combination and consent
   * hasn't already been granted. Does NOT install anything on the caller's
   * behalf when consent is required and not yet given — it returns
   * "awaiting-consent" so the caller (skill loader) can surface that to the
   * user instead of silently blocking or silently installing.
   */
  async ensureRuntimeReady(
    skillId: string,
    requirement: RuntimeRequirement,
  ): Promise<EnsureRuntimeOutcome> {
    const language = requirement.language.toLowerCase();

    if (!this.allowedLanguages.has(language)) {
      return { outcome: "unsupported-language", language };
    }
    if (this.approvalLevel === "DISABLED") {
      return {
        outcome: "failed",
        error: `runtime_installer is disabled in config/tools.yaml; cannot fetch ${language} packages for ${skillId}.`,
      };
    }

    const resolver = this.resolvers.get(language);
    if (!resolver) {
      return { outcome: "unsupported-language", language };
    }

    const sandboxPath = this.sandboxPaths.forSkillLanguage(skillId, language);

    // Already installed and verified? Nothing to do.
    const check = await resolver.checkPackages(
      sandboxPath,
      requirement.packages,
    );
    if (check.satisfied) {
      return { outcome: "already-satisfied" };
    }

    if (!(await resolver.isRuntimeAvailable())) {
      return {
        outcome: "runtime-unavailable",
        language,
        hint: resolver.runtimeInstallHint(),
      };
    }

    const existing = this.consentStore.findByFingerprint(
      skillId,
      language,
      requirement.packages,
    );

    const skipConsent = this.approvalLevel === "TRUSTED_FULL_ACCESS";

    let requestId: string;
    if (existing) {
      if (existing.status === "denied") {
        return { outcome: "denied", requestId: existing.id };
      }
      if (existing.status === "pending" && !skipConsent) {
        return { outcome: "awaiting-consent", requestId: existing.id };
      }
      requestId = existing.id;
      if (existing.status === "pending" && skipConsent) {
        this.consentStore.decide(existing.id, "approved", "auto");
      }
    } else {
      const created = this.consentStore.createPending(
        skillId,
        language,
        requirement.packages,
        requirement.version,
        `Skill "${skillId}" requires ${language} packages: ${requirement.packages.join(", ") || "(runtime only)"}`,
      );
      requestId = created.id;
      if (skipConsent) {
        this.consentStore.decide(created.id, "approved", "auto");
      } else {
        return { outcome: "awaiting-consent", requestId };
      }
    }

    // Consent has been granted (either previously or auto-approved above).
    this.consentStore.markInstalling(requestId);
    const result = await resolver.install(
      sandboxPath,
      requirement.packages,
      requirement.version,
    );

    if (!result.success) {
      this.consentStore.markFailed(
        requestId,
        result.error || "Unknown install failure",
        result.manualInstructions,
      );
      return {
        outcome: "failed",
        error: result.error || "Unknown install failure",
        manualInstructions: result.manualInstructions,
      };
    }

    this.consentStore.markReady(requestId, result.sandboxPath || sandboxPath);
    return {
      outcome: "installed",
      sandboxPath: result.sandboxPath || sandboxPath,
    };
  }

  /**
   * Called by the CLI/UI approval endpoint once a human approves or denies a
   * pending request. Approving does NOT install synchronously here — the
   * next call to ensureRuntimeReady for the same skill will proceed with the
   * actual install now that status is "approved".
   */
  recordDecision(
    requestId: string,
    approved: boolean,
    decidedBy?: string,
  ): void {
    this.consentStore.decide(
      requestId,
      approved ? "approved" : "denied",
      decidedBy,
    );
  }
}
