const CONTROL_CHARS = /[\x00-\x1F\x7F]/;
const PATH_SEPARATORS = /[\\/]/;
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function assertNoPathSegments(value: string, label: string): void {
  if (CONTROL_CHARS.test(value) || PATH_SEPARATORS.test(value)) {
    throw new Error(`${label} must not contain path separators or controls`);
  }
}

export function safeTempName(value: string): string {
  const safe = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return safe || "package";
}

export function validateNpmPackageName(packageName: string): void {
  if (!NPM_PACKAGE_NAME.test(packageName)) {
    throw new Error(`Invalid npm package name "${packageName}"`);
  }
}

export function validateGitBranchName(branch: string): void {
  if (
    CONTROL_CHARS.test(branch) ||
    /\s/.test(branch) ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("\\") ||
    branch.includes("//") ||
    branch.endsWith(".lock")
  ) {
    throw new Error(`Invalid git branch name "${branch}"`);
  }
}
