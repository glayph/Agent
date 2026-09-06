import * as os from "os";
import * as path from "path";

import { normalizeRuntimePaths, resolveRuntimePaths } from "./paths.js";

function withEnv<T>(
  values: Record<string, string | undefined>,
  fn: () => T,
): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("runtime path isolation", () => {
  it("uses MIKI_RUNTIME_ROOT for mutable runtime state", () => {
    const runtimeRoot = path.join(os.tmpdir(), "miki-paths-runtime");
    const workspaceRoot = path.join(os.tmpdir(), "miki-paths-workspace");

    withEnv(
      {
        MIKI_RUNTIME_ROOT: runtimeRoot,
        MIKI_WORKSPACE_DIR: workspaceRoot,
      },
      () => {
        const paths = resolveRuntimePaths();
        expect(paths.configDir).toBe(path.join(runtimeRoot, "config"));
        expect(paths.dataDir).toBe(path.join(runtimeRoot, "data"));
        expect(paths.skillsDir).toBe(path.join(runtimeRoot, "skills"));
        expect(paths.cacheDir).toBe(path.join(runtimeRoot, "cache"));
        expect(paths.sourceDir).toBe(path.resolve(workspaceRoot));
      },
    );
  });

  it("keeps explicit raw workspace normalization backward-compatible", () => {
    const workspaceRoot = path.join(os.tmpdir(), "miki-paths-legacy");
    const paths = normalizeRuntimePaths(workspaceRoot);
    expect(paths.configDir).toBe(path.join(workspaceRoot, "config"));
    expect(paths.dataDir).toBe(path.join(workspaceRoot, "data"));
    expect(paths.sourceDir).toBe(path.resolve(workspaceRoot));
  });
});

export {};
