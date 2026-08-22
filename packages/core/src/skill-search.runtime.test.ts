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

function makeEngine(): { engine: SkillSearchEngine; skillsRoot: string } {
  const workspaceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "Miki-runtime-skill-"),
  );
  const skillsRoot = path.join(workspaceDir, "custom-skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(skillsRoot, "categories.json"),
    JSON.stringify({ categories: ["software-development", "research"] }),
    "utf-8",
  );
  const engine = new SkillSearchEngine(makeRuntimePaths(workspaceDir), [
    skillsRoot,
  ]);
  return { engine, skillsRoot };
}

describe("SkillMetadata runtime requirements", () => {
  it("parses a nested runtime: block (python-debugpy style)", async () => {
    const { engine, skillsRoot } = makeEngine();
    writeSkill(
      skillsRoot,
      "software-development",
      "python-debugpy",
      [
        "---",
        "name: python-debugpy",
        'description: "Debug Python: pdb REPL + debugpy remote (DAP)."',
        "version: 1.0.0",
        "runtime:",
        "  - language: python",
        "    packages: [debugpy, remote-pdb]",
        "---",
      ].join("\n"),
    );

    const skill = await engine.getSkill("software-development/python-debugpy");
    expect(skill).not.toBeNull();
    expect(skill!.runtime).toEqual([
      {
        language: "python",
        version: undefined,
        packages: ["debugpy", "remote-pdb"],
      },
    ]);
  });

  it("treats a legacy flat dependencies: list as an implicit python runtime requirement", async () => {
    const { engine, skillsRoot } = makeEngine();
    writeSkill(
      skillsRoot,
      "research",
      "research-paper-writing",
      [
        "---",
        "name: research-paper-writing",
        'description: "Write ML papers."',
        "version: 1.1.0",
        "dependencies: [semanticscholar, arxiv, numpy, matplotlib]",
        "---",
      ].join("\n"),
    );

    const skill = await engine.getSkill("research/research-paper-writing");
    expect(skill).not.toBeNull();
    expect(skill!.dependencies).toEqual([
      "semanticscholar",
      "arxiv",
      "numpy",
      "matplotlib",
    ]);
    expect(skill!.runtime).toEqual([
      {
        language: "python",
        packages: ["semanticscholar", "arxiv", "numpy", "matplotlib"],
      },
    ]);
  });

  it("supports multiple runtime languages for one skill", async () => {
    const { engine, skillsRoot } = makeEngine();
    writeSkill(
      skillsRoot,
      "software-development",
      "multi-lang-tool",
      [
        "---",
        "name: multi-lang-tool",
        "description: Needs both Python and Rust helpers",
        "runtime:",
        "  - language: python",
        "    packages: [requests]",
        "  - language: rust",
        "    version: '>=1.70'",
        "    packages: [ripgrep]",
        "---",
      ].join("\n"),
    );

    const skill = await engine.getSkill("software-development/multi-lang-tool");
    expect(skill!.runtime).toHaveLength(2);
    expect(skill!.runtime![0].language).toBe("python");
    expect(skill!.runtime![1]).toEqual({
      language: "rust",
      version: ">=1.70",
      packages: ["ripgrep"],
    });
  });

  it("leaves runtime undefined for skills with no dependencies at all", async () => {
    const { engine, skillsRoot } = makeEngine();
    writeSkill(
      skillsRoot,
      "software-development",
      "no-deps-skill",
      [
        "---",
        "name: no-deps-skill",
        "description: Pure TypeScript skill, no external runtime",
        "---",
      ].join("\n"),
    );

    const skill = await engine.getSkill("software-development/no-deps-skill");
    expect(skill!.runtime).toBeUndefined();
  });
});
