import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RuntimeFetcher } from "../../src/runtime-fetch/index.js";
import type {
  LanguageResolver,
  RuntimeCheckResult,
  RuntimeInstallResult,
  ShellRunner,
} from "../../src/runtime-fetch/types.js";

// A no-op shell runner: the fake resolvers below never actually invoke it,
// but RuntimeFetcher's constructor wires it into the real Python/Ruby/Rust/
// Node resolvers too, so it must exist and be well-typed.
const fakeShell: ShellRunner = {
  async runShell() {
    return { stdout: "", stderr: "", exitCode: 0, error: "" };
  },
};

class FakeResolver implements LanguageResolver {
  public installCalls: Array<{ sandboxPath: string; packages: string[] }> = [];
  constructor(
    readonly language: string,
    private opts: {
      available?: boolean;
      alreadySatisfied?: boolean;
      installSucceeds?: boolean;
    } = {},
  ) {}

  async isRuntimeAvailable(): Promise<boolean> {
    return this.opts.available ?? true;
  }

  runtimeInstallHint(): string {
    return `install ${this.language} manually`;
  }

  async checkPackages(
    _sandboxPath: string,
    packages: string[],
  ): Promise<RuntimeCheckResult> {
    if (this.opts.alreadySatisfied) {
      return { satisfied: true, sandboxReady: true, missingPackages: [] };
    }
    return { satisfied: false, sandboxReady: false, missingPackages: packages };
  }

  async install(
    sandboxPath: string,
    packages: string[],
  ): Promise<RuntimeInstallResult> {
    this.installCalls.push({ sandboxPath, packages });
    if (this.opts.installSucceeds === false) {
      return {
        success: false,
        installedPackages: [],
        error: "simulated install failure",
        manualInstructions: `manual: install ${packages.join(", ")}`,
      };
    }
    return { success: true, sandboxPath, installedPackages: packages };
  }
}

function makeFetcher(
  approvalLevel: "REQUIRE_APPROVAL" | "TRUSTED_FULL_ACCESS" | "DISABLED",
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-fetch-test-"));
  const db = new Database(":memory:");
  const fetcher = new RuntimeFetcher({
    dataDir,
    shell: fakeShell,
    approvalLevel,
    db,
  });
  return { fetcher, dataDir };
}

describe("RuntimeFetcher", () => {
  it("reports already-satisfied without creating any consent request", async () => {
    const { fetcher } = makeFetcher("REQUIRE_APPROVAL");
    const resolver = new FakeResolver("python", { alreadySatisfied: true });
    fetcher.registerResolver(resolver);

    const result = await fetcher.ensureRuntimeReady("skill-a", {
      language: "python",
      packages: ["debugpy"],
    });
    expect(result.outcome).toBe("already-satisfied");
    expect(fetcher.getConsentStore().listPending()).toHaveLength(0);
  });

  it("returns awaiting-consent on first request and never installs without approval", async () => {
    const { fetcher } = makeFetcher("REQUIRE_APPROVAL");
    const resolver = new FakeResolver("python");
    fetcher.registerResolver(resolver);

    const result = await fetcher.ensureRuntimeReady("skill-a", {
      language: "python",
      packages: ["debugpy"],
    });
    expect(result.outcome).toBe("awaiting-consent");
    expect(resolver.installCalls).toHaveLength(0);

    const pending = fetcher.getConsentStore().listPending();
    expect(pending).toHaveLength(1);
  });

  it("installs after the pending request is approved", async () => {
    const { fetcher } = makeFetcher("REQUIRE_APPROVAL");
    const resolver = new FakeResolver("python");
    fetcher.registerResolver(resolver);

    const first = await fetcher.ensureRuntimeReady("skill-a", {
      language: "python",
      packages: ["debugpy"],
    });
    expect(first.outcome).toBe("awaiting-consent");
    const requestId = (first as { requestId: string }).requestId;

    fetcher.recordDecision(requestId, true, "test-user");

    const second = await fetcher.ensureRuntimeReady("skill-a", {
      language: "python",
      packages: ["debugpy"],
    });
    expect(second.outcome).toBe("installed");
    expect(resolver.installCalls).toHaveLength(1);
  });

  it("never installs again after a request is denied", async () => {
    const { fetcher } = makeFetcher("REQUIRE_APPROVAL");
    const resolver = new FakeResolver("python");
    fetcher.registerResolver(resolver);

    const first = await fetcher.ensureRuntimeReady("skill-a", {
      language: "python",
      packages: ["debugpy"],
    });
    const requestId = (first as { requestId: string }).requestId;
    fetcher.recordDecision(requestId, false);

    const second = await fetcher.ensureRuntimeReady("skill-a", {
      language: "python",
      packages: ["debugpy"],
    });
    expect(second.outcome).toBe("denied");
    expect(resolver.installCalls).toHaveLength(0);
  });

  it("auto-approves and installs immediately when level is TRUSTED_FULL_ACCESS", async () => {
    const { fetcher } = makeFetcher("TRUSTED_FULL_ACCESS");
    const resolver = new FakeResolver("python");
    fetcher.registerResolver(resolver);

    const result = await fetcher.ensureRuntimeReady("skill-a", {
      language: "python",
      packages: ["debugpy"],
    });
    expect(result.outcome).toBe("installed");
    expect(resolver.installCalls).toHaveLength(1);
  });

  it("refuses to install anything when level is DISABLED", async () => {
    const { fetcher } = makeFetcher("DISABLED");
    const resolver = new FakeResolver("python");
    fetcher.registerResolver(resolver);

    const result = await fetcher.ensureRuntimeReady("skill-a", {
      language: "python",
      packages: ["debugpy"],
    });
    expect(result.outcome).toBe("failed");
    expect(resolver.installCalls).toHaveLength(0);
  });

  it("reports runtime-unavailable with a manual hint instead of failing silently", async () => {
    const { fetcher } = makeFetcher("TRUSTED_FULL_ACCESS");
    const resolver = new FakeResolver("ruby", { available: false });
    fetcher.registerResolver(resolver);

    const result = await fetcher.ensureRuntimeReady("skill-a", {
      language: "ruby",
      packages: ["nokogiri"],
    });
    expect(result.outcome).toBe("runtime-unavailable");
    if (result.outcome === "runtime-unavailable") {
      expect(result.hint).toContain("ruby");
    }
  });

  it("surfaces install failure with manual fallback instructions, never silent", async () => {
    const { fetcher } = makeFetcher("TRUSTED_FULL_ACCESS");
    const resolver = new FakeResolver("python", { installSucceeds: false });
    fetcher.registerResolver(resolver);

    const result = await fetcher.ensureRuntimeReady("skill-a", {
      language: "python",
      packages: ["debugpy"],
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.error).toContain("simulated install failure");
      expect(result.manualInstructions).toContain("manual:");
    }
  });

  it("rejects languages not in the allowed_languages list", async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "runtime-fetch-test-"),
    );
    const db = new Database(":memory:");
    const fetcher = new RuntimeFetcher({
      dataDir,
      shell: fakeShell,
      approvalLevel: "TRUSTED_FULL_ACCESS",
      allowedLanguages: ["python"],
      db,
    });
    const resolver = new FakeResolver("php");
    fetcher.registerResolver(resolver);

    const result = await fetcher.ensureRuntimeReady("skill-a", {
      language: "php",
      packages: ["some/pkg"],
    });
    expect(result.outcome).toBe("unsupported-language");
  });

  it("does not re-prompt for the same skill+language when packages are reordered", async () => {
    const { fetcher } = makeFetcher("REQUIRE_APPROVAL");
    const resolver = new FakeResolver("python");
    fetcher.registerResolver(resolver);

    const first = await fetcher.ensureRuntimeReady("skill-a", {
      language: "python",
      packages: ["debugpy", "remote-pdb"],
    });
    expect(first.outcome).toBe("awaiting-consent");

    const second = await fetcher.ensureRuntimeReady("skill-a", {
      language: "python",
      packages: ["remote-pdb", "debugpy"],
    });
    // Same fingerprint -> same still-pending request, not a new one.
    expect(second.outcome).toBe("awaiting-consent");
    if (
      first.outcome === "awaiting-consent" &&
      second.outcome === "awaiting-consent"
    ) {
      expect(second.requestId).toBe(first.requestId);
    }
    expect(fetcher.getConsentStore().listPending()).toHaveLength(1);
  });
});
