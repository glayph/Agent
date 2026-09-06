import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldCopyRuntimeFile,
  isExcludedTestDirectory,
} from "./runtime-package-filters.mjs";

test("shouldCopyRuntimeFile: excludes source maps", () => {
  assert.equal(shouldCopyRuntimeFile("/repo/dist/api/index.js.map"), false);
  assert.equal(shouldCopyRuntimeFile("/repo/dist/index.d.ts.map"), false);
});

test("shouldCopyRuntimeFile: excludes *.test.js/.ts/.jsx/.tsx/.mjs/.cjs variants", () => {
  assert.equal(
    shouldCopyRuntimeFile("/repo/packages/memory/src/test/learning-store.test.js"),
    false,
  );
  assert.equal(shouldCopyRuntimeFile("/repo/src/foo.test.ts"), false);
  assert.equal(shouldCopyRuntimeFile("/repo/src/foo.test.tsx"), false);
  assert.equal(shouldCopyRuntimeFile("/repo/src/foo.test.jsx"), false);
  assert.equal(shouldCopyRuntimeFile("/repo/src/foo.test.mjs"), false);
  assert.equal(shouldCopyRuntimeFile("/repo/src/foo.test.cjs"), false);
});

test("shouldCopyRuntimeFile: is case-insensitive", () => {
  assert.equal(shouldCopyRuntimeFile("/repo/src/Foo.TEST.JS"), false);
  assert.equal(shouldCopyRuntimeFile("/repo/dist/Index.JS.MAP"), false);
});

test("shouldCopyRuntimeFile: allows normal runtime source/compiled files", () => {
  assert.equal(shouldCopyRuntimeFile("/repo/dist/api/index.js"), true);
  assert.equal(shouldCopyRuntimeFile("/repo/dist/api/inspector-events.js"), true);
  assert.equal(shouldCopyRuntimeFile("/repo/dist/api/index.d.ts"), true);
  assert.equal(shouldCopyRuntimeFile("/repo/package.json"), true);
});

test("shouldCopyRuntimeFile: does not false-positive on filenames that merely contain 'test'", () => {
  // A real file in this codebase: packages/memory/src/test/tkg-test-runner.js.
  // The filename contains "test" but does not match the `.test.<ext>` suffix
  // pattern, so file-level filtering intentionally leaves it to directory-level
  // filtering (isExcludedTestDirectory) instead of also matching it here.
  assert.equal(shouldCopyRuntimeFile("/repo/src/test/tkg-test-runner.js"), true);
  assert.equal(shouldCopyRuntimeFile("/repo/src/latest-results.js"), true);
  assert.equal(shouldCopyRuntimeFile("/repo/src/attestation.js"), true);
});

test("isExcludedTestDirectory: matches known test directory names", () => {
  assert.equal(isExcludedTestDirectory("/repo/packages/memory/src/test"), true);
  assert.equal(isExcludedTestDirectory("/repo/packages/foo/tests"), true);
  assert.equal(isExcludedTestDirectory("/repo/packages/foo/__tests__"), true);
  assert.equal(isExcludedTestDirectory("/repo/packages/foo/__mocks__"), true);
});

test("isExcludedTestDirectory: is case-insensitive", () => {
  assert.equal(isExcludedTestDirectory("/repo/packages/foo/Test"), true);
  assert.equal(isExcludedTestDirectory("/repo/packages/foo/TESTS"), true);
});

test("isExcludedTestDirectory: does not match unrelated or similarly-named directories", () => {
  assert.equal(isExcludedTestDirectory("/repo/packages/core/src/api"), false);
  assert.equal(isExcludedTestDirectory("/repo/packages/core/src/testing-utils"), false);
  assert.equal(isExcludedTestDirectory("/repo/packages/core/src/latest"), false);
  assert.equal(isExcludedTestDirectory("/repo/packages/core/dist"), false);
});
