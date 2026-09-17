import path from "node:path";

/**
 * Pure filtering predicates for prepare-runtime-package.mjs's recursive
 * copy. Kept in their own module (no filesystem side effects, no top-level
 * execution) so they can be unit tested directly — prepare-runtime-package.mjs
 * itself runs its packaging work as soon as it's imported, which makes it
 * unsuitable to import from a test.
 */

const TEST_FILE_PATTERN = /\.test\.[cm]?[jt]sx?$/i;
const TEST_DIR_NAMES = new Set(["test", "tests", "__tests__", "__mocks__"]);

/**
 * Whether a single file should be copied into the published runtime bundle.
 * Excludes source maps (not needed at runtime) and test files (development
 * -only, never executed by the published package). Test-file exclusion
 * matters most for source-only packages (e.g. @miki/memory) that copy a
 * package's src/ directly with no build step to otherwise strip
 * `*.test.js` out of.
 */
export function shouldCopyRuntimeFile(sourcePath) {
  if (path.extname(sourcePath).toLowerCase() === ".map") return false;
  if (TEST_FILE_PATTERN.test(path.basename(sourcePath))) return false;
  return true;
}

/**
 * Whether an entire directory should be skipped during the recursive copy.
 * Matches directories that exist solely to hold test code (test/, tests/,
 * __tests__/, __mocks__/) — verified against this codebase to have no
 * false positives (no such directory holds runtime/production content
 * anywhere in packages/*\/src).
 */
export function isExcludedTestDirectory(sourcePath) {
  return TEST_DIR_NAMES.has(path.basename(sourcePath).toLowerCase());
}
