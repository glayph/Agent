import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolRegistry } from "./executor.js";

describe("ToolRegistry", () => {
  it("does not expose the system index search tool", () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tool-registry-"),
    );

    try {
      const registry = new ToolRegistry({
        configDir: path.join(workspaceDir, "config"),
        dataDir: path.join(workspaceDir, "data"),
        skillsDir: path.join(workspaceDir, "src", "skills"),
        cacheDir: path.join(workspaceDir, "data", "cache"),
        binDir: path.join(workspaceDir, "bin"),
        docsDir: path.join(workspaceDir, "docs"),
        outputDir: path.join(workspaceDir, "output"),
        sourceDir: workspaceDir,
      });

      const names = registry
        .getToolDefinitions()
        .map((tool) => tool.function?.name ?? "");

      expect(names).not.toContain("system_index_search");
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
