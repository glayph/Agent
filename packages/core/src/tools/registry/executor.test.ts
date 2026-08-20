import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolRegistry } from "./executor.js";

describe("ToolRegistry", () => {
  function createRegistry(workspaceDir: string): ToolRegistry {
    return new ToolRegistry({
      configDir: path.join(workspaceDir, "config"),
      dataDir: path.join(workspaceDir, "data"),
      skillsDir: path.join(workspaceDir, "src", "skills"),
      cacheDir: path.join(workspaceDir, "data", "cache"),
      binDir: path.join(workspaceDir, "bin"),
      docsDir: path.join(workspaceDir, "docs"),
      outputDir: path.join(workspaceDir, "output"),
      sourceDir: workspaceDir,
    });
  }

  it("does not expose the system index search tool", () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tool-registry-"),
    );

    try {
      const names = createRegistry(workspaceDir)
        .getToolDefinitions()
        .map((tool) => tool.function?.name ?? "");

      expect(names).not.toContain("system_index_search");
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reports file-operation errors as failed structured results", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tool-registry-file-error-"),
    );

    try {
      const result = await createRegistry(workspaceDir).executeToolStructured(
        "file_read",
        { path: path.join(workspaceDir, "missing.txt") },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("file_read failed");
      expect(result.output).toBe("");
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("honors file-delete dry runs and leaves the file in place", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tool-registry-file-dry-run-"),
    );
    const targetPath = path.join(workspaceDir, "keep.txt");
    fs.writeFileSync(targetPath, "keep", "utf-8");

    try {
      const result = await createRegistry(workspaceDir).executeToolStructured(
        "file_delete",
        { path: targetPath, dryRun: true },
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("DRY-RUN");
      expect(fs.existsSync(targetPath)).toBe(true);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
