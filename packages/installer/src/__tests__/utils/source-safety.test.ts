import {
  assertNoPathSegments,
  safeTempName,
  validateGitBranchName,
  validateNpmPackageName,
} from "../../utils/source-safety";

describe("source safety helpers", () => {
  it("rejects path segments in Clawhub-style package names", () => {
    expect(() => assertNoPathSegments("../plugin", "Package name")).toThrow(
      /path separators/,
    );
    expect(() => assertNoPathSegments("scope\\plugin", "Package name")).toThrow(
      /path separators/,
    );
  });

  it("sanitizes package names for temporary directory names", () => {
    expect(safeTempName("@scope/plugin")).toBe("scope_plugin");
    expect(safeTempName(" plugin:name ")).toBe("plugin_name");
  });

  it("accepts valid npm package names and rejects path traversal", () => {
    expect(() => validateNpmPackageName("@scope/plugin")).not.toThrow();
    expect(() => validateNpmPackageName("plain-plugin")).not.toThrow();
    expect(() => validateNpmPackageName("../plugin")).toThrow(
      /Invalid npm package name/,
    );
  });

  it("rejects unsafe git branch names", () => {
    expect(() => validateGitBranchName("feature/auth-hardening")).not.toThrow();
    expect(() => validateGitBranchName("--upload-pack=cmd")).toThrow(
      /Invalid git branch name/,
    );
    expect(() => validateGitBranchName("feature/../main")).toThrow(
      /Invalid git branch name/,
    );
  });
});
