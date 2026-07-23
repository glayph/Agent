import fs from "fs";
import os from "os";
import path from "path";
import { SkillSearchEngine } from "./skill-search.js";
import { type RuntimePaths } from "./paths.js";

function makeRuntimePaths(workspaceDir: string): RuntimePaths {
  return {
    configDir: path.join(workspaceDir, "config"),
    dataDir: path.join(workspaceDir, "data"),
    skillsDir: path.join(workspaceDir, "src", "skills"),
    cacheDir: path.join(workspaceDir, "data", "cache"),
    binDir: path.join(workspaceDir, "bin"),
    docsDir: path.join(workspaceDir, "docs"),
    outputDir: path.join(workspaceDir, "output"),
    sourceDir: workspaceDir,
  };
}

function writeSkill(
  root: string,
  category: string,
  name: string,
  frontmatter: string,
) {
  const categoryDir = path.join(root, category);
  const skillDir = path.join(categoryDir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), frontmatter, "utf-8");

  const skillsPath = path.join(categoryDir, "skills.json");
  const skills = fs.existsSync(skillsPath)
    ? (
        JSON.parse(fs.readFileSync(skillsPath, "utf-8")) as {
          skills: string[];
        }
      ).skills
    : [];
  fs.writeFileSync(
    skillsPath,
    JSON.stringify({ skills: [...skills, name] }),
    "utf-8",
  );
}

describe("SkillSearchEngine", () => {
  it("deduplicates query terms and ranks relevant skills first", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "Hiro-skill-"));
    const skillsRoot = path.join(workspaceDir, "custom-skills");
    fs.mkdirSync(skillsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(skillsRoot, "categories.json"),
      JSON.stringify({ categories: ["development", "research"] }),
      "utf-8",
    );
    writeSkill(
      skillsRoot,
      "development",
      "mcp-debug",
      [
        "---",
        "name: mcp-debug",
        "description: Debug MCP plugin and tool routing issues",
        "tags: [mcp, plugin, debug]",
        "---",
      ].join("\n"),
    );
    writeSkill(
      skillsRoot,
      "research",
      "paper-search",
      [
        "---",
        "name: paper-search",
        "description: Search academic papers",
        "tags: [research]",
        "---",
      ].join("\n"),
    );

    const engine = new SkillSearchEngine(makeRuntimePaths(workspaceDir), [
      skillsRoot,
    ]);
    const result = await engine.search({
      keywords: ["MCP MCP plugin"],
      limit: 5,
    });

    expect(result.results[0].id).toBe("development/mcp-debug");
  });
});
