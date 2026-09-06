/**
 * Multi-language runtime fetcher — shared types.
 *
 * These types describe a skill's declared need for an external language
 * runtime (Python, Ruby, Rust, ...) and the packages it needs inside that
 * runtime. Agent core itself stays Go + TypeScript only; this subsystem
 * exists so that a *skill* which genuinely needs another language's
 * ecosystem (e.g. `python-debugpy` needing `debugpy`) can get it fetched
 * on-demand, into an isolated sandbox, with explicit user consent — instead
 * of the agent bundling that dependency itself or asking the user to run
 * `pip install` by hand.
 */

/** One external-runtime requirement declared by a skill's SKILL.md frontmatter. */
export interface RuntimeRequirement {
  /** Lowercased language/runtime identifier, e.g. "python", "ruby", "rust", "node". */
  language: string;
  /** Optional version constraint understood by that language's resolver (e.g. ">=3.9"). */
  version?: string;
  /** Package names to install inside the sandboxed environment for this language. */
  packages: string[];
}

export type RuntimeInstallStatus =
  | "pending" // waiting on user consent
  | "approved" // consent given, install not yet attempted
  | "denied" // user declined
  | "installing"
  | "ready" // installed and verified usable
  | "failed";

/** A durable record of one (skill, language) runtime-install request. */
export interface RuntimeInstallRequest {
  id: string;
  skillId: string;
  language: string;
  packages: string[];
  versionConstraint?: string;
  status: RuntimeInstallStatus;
  /** Human-readable reason surfaced to the consent UI. */
  reason?: string;
  /** Populated on failure — never silent. */
  error?: string;
  /** Manual fallback instructions to show the user if auto-install fails. */
  manualInstructions?: string;
  /** Absolute path to the isolated sandbox once ready. */
  sandboxPath?: string;
  createdAt: number;
  updatedAt: number;
  decidedAt?: number;
  decidedBy?: string;
}

/** Result of checking whether a runtime requirement is already satisfied. */
export interface RuntimeCheckResult {
  satisfied: boolean;
  /** True if the sandbox exists and reports the packages as installed. */
  sandboxReady: boolean;
  missingPackages: string[];
  detail?: string;
}

/** Result of an actual install attempt. */
export interface RuntimeInstallResult {
  success: boolean;
  sandboxPath?: string;
  installedPackages: string[];
  error?: string;
  manualInstructions?: string;
}

/**
 * Per-language adapter contract. Every supported language implements this
 * so the orchestrator (`index.ts`) stays language-agnostic.
 */
export interface LanguageResolver {
  /** Lowercased language id this resolver handles, e.g. "python". */
  readonly language: string;

  /** Is the base interpreter/toolchain available on this machine at all? */
  isRuntimeAvailable(): Promise<boolean>;

  /** Human-readable install hint for the base interpreter itself (not packages). */
  runtimeInstallHint(): string;

  /** Check which requested packages are missing from the given sandbox. */
  checkPackages(
    sandboxPath: string,
    packages: string[],
  ): Promise<RuntimeCheckResult>;

  /**
   * Create the sandbox (if needed) and install the given packages into it.
   * Implementations MUST only call out to the official package manager for
   * their language (pip, npm, gem, cargo, ...) via the provided shell runner
   * — never arbitrary shell/curl scripts, never sudo/root.
   */
  install(
    sandboxPath: string,
    packages: string[],
    versionConstraint?: string,
  ): Promise<RuntimeInstallResult>;
}

/** Minimal shell-execution contract the resolvers depend on (implemented by
 * core's ShellExecutor) so this package never spawns processes on its own. */
export interface ShellRunner {
  runShell(
    command: string,
    cwd?: string,
    timeout?: number,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    error: string;
  }>;
}
