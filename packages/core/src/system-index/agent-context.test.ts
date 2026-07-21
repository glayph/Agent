import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildSystemIndexContext,
  searchSystemIndexForAgent,
} from "./agent-context.js";

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "Hiro-agent-index-"));
}

describe("agent system index context", () => {
  test("returns no context when system index support is disabled", () => {
    const workspace = makeWorkspace();

    try {
      const context = buildSystemIndexContext(workspace, "predictive");
      expect(context).toBe("");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("returns empty context without indexing when support is disabled", () => {
    const workspace = makeWorkspace();

    try {
      const payload = searchSystemIndexForAgent(
        {
          configDir: path.join(workspace, "config"),
          dataDir: path.join(workspace, "data"),
          skillsDir: path.join(workspace, "src", "skills"),
          cacheDir: path.join(workspace, "data", "cache"),
          binDir: path.join(workspace, "bin"),
          docsDir: path.join(workspace, "docs"),
          outputDir: path.join(workspace, "output"),
          sourceDir: workspace,
        },
        "predictive",
        5,
      );
      expect(payload.indexedFiles).toBe(0);
      expect(payload.results).toEqual([]);

      const context = buildSystemIndexContext(
        {
          configDir: path.join(workspace, "config"),
          dataDir: path.join(workspace, "data"),
          skillsDir: path.join(workspace, "src", "skills"),
          cacheDir: path.join(workspace, "data", "cache"),
          binDir: path.join(workspace, "bin"),
          docsDir: path.join(workspace, "docs"),
          outputDir: path.join(workspace, "output"),
          sourceDir: workspace,
        },
        "predictive",
      );
      expect(context).toBe("");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
