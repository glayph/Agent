/**
 * Skill Loader and Registry Integration
 * Dynamically loads skills from src/skills/* and registers them with the ToolRegistry
 * Skills are loaded on-demand based on agent needs
 */

import * as path from "path";
import * as fs from "fs";
import { SkillMetadata, SkillSearchEngine } from "./skill-search.js";
import { normalizeRuntimePaths, type RuntimePaths } from "./paths.js";

export interface SkillDefinition {
  metadata: SkillMetadata;
  index: string; // Path to index.ts or main file
  tools?: Array<{
    name: string;
    description: string;
    schema: unknown;
  }>;
}

export class SkillLoader {
  private searchEngine: SkillSearchEngine;
  private loadedSkills: Map<string, SkillDefinition> = new Map();
  public runtimePaths: RuntimePaths;
  constructor(paths: RuntimePaths | string) {
    this.runtimePaths = normalizeRuntimePaths(paths);
    this.searchEngine = new SkillSearchEngine(this.runtimePaths);
  }

  /**
   * Get the skill search engine instance
   */
  getSearchEngine(): SkillSearchEngine {
    return this.searchEngine;
  }

  /**
   * Load a skill by ID and return its definition
   */
  async loadSkill(skillId: string): Promise<SkillDefinition | null> {
    // Check if already loaded
    if (this.loadedSkills.has(skillId)) {
      return this.loadedSkills.get(skillId)!;
    }

    // Get skill metadata
    const metadata = await this.searchEngine.getSkill(skillId);
    if (!metadata) {
      console.error(`Skill not found: ${skillId}`);
      return null;
    }

    if (!metadata.enabled) {
      console.warn(`Skill is disabled: ${skillId}`);
      return null;
    }

    // Find the main entry point
    const indexPath = this.findSkillIndex(metadata.path);
    // Create skill definition
    const skillDef: SkillDefinition = {
      metadata,
      index: indexPath || "",
      tools: [],
    };

    // Try to load tools metadata if exists
    const toolsMetaPath = path.join(metadata.path, "tools.json");
    if (fs.existsSync(toolsMetaPath)) {
      try {
        const toolsMeta = JSON.parse(fs.readFileSync(toolsMetaPath, "utf-8"));
        skillDef.tools = toolsMeta.tools || [];
      } catch (err) {
        console.error(`Failed to load tools metadata for ${skillId}:`, err);
      }
    }

    this.loadedSkills.set(skillId, skillDef);
    return skillDef;
  }

  /**
   * Load multiple skills by category
   */
  async loadCategory(category: string): Promise<SkillDefinition[]> {
    const skillsInCategory = await this.searchEngine.getCategory(category);
    const loaded: SkillDefinition[] = [];

    for (const metadata of skillsInCategory) {
      const skill = await this.loadSkill(metadata.id);
      if (skill) {
        loaded.push(skill);
      }
    }

    return loaded;
  }

  /**
   * Load all available skills
   */
  async loadAll(): Promise<SkillDefinition[]> {
    const allSkills = await this.searchEngine.listAll(true); // Only enabled
    const loaded: SkillDefinition[] = [];

    for (const metadata of allSkills) {
      const skill = await this.loadSkill(metadata.id);
      if (skill) {
        loaded.push(skill);
      }
    }

    return loaded;
  }

  /**
   * Search and load skills matching query
   */
  async searchAndLoad(
    keywords?: string[],
    category?: string,
    limit?: number,
  ): Promise<SkillDefinition[]> {
    const searchResult = await this.searchEngine.search({
      keywords,
      category,
      enabled: true,
      limit,
    });

    const loaded: SkillDefinition[] = [];
    for (const metadata of searchResult.results) {
      const skill = await this.loadSkill(metadata.id);
      if (skill) {
        loaded.push(skill);
      }
    }

    return loaded;
  }

  /**
   * Get a list of all available skills with their metadata
   */
  async getAllSkillsMetadata(): Promise<SkillMetadata[]> {
    return this.searchEngine.listAll(true);
  }

  /**
   * Unload a skill
   */
  unloadSkill(skillId: string): void {
    this.loadedSkills.delete(skillId);
  }

  /**
   * Clear all loaded skills
   */
  clearLoaded(): void {
    this.loadedSkills.clear();
  }

  /**
   * Get list of loaded skills
   */
  getLoadedSkills(): Array<{ id: string; name: string; path: string }> {
    return Array.from(this.loadedSkills.values()).map((skill) => ({
      id: skill.metadata.id,
      name: skill.metadata.name,
      path: skill.index,
    }));
  }

  /**
   * Find the main index or entry file of a skill.
   * Checks index.ts, index.js, index.mjs, index.cjs, main.ts, main.js,
   * or package.json main entry. Note: SKILL.md is documentation only and
   * is never treated as an importable module.
   */
  private findSkillIndex(skillPath: string): string {
    const candidates = [
      path.join(skillPath, "index.ts"),
      path.join(skillPath, "index.js"),
      path.join(skillPath, "index.mjs"),
      path.join(skillPath, "index.cjs"),
      path.join(skillPath, "main.ts"),
      path.join(skillPath, "main.js"),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    // Check package.json main if present
    const pkgPath = path.join(skillPath, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.main && typeof pkg.main === "string") {
          const resolvedMain = path.resolve(skillPath, pkg.main);
          if (fs.existsSync(resolvedMain)) return resolvedMain;
        }
      } catch {
        // ignore JSON parse errors
      }
    }

    // No importable module found (e.g. documentation-only skill with just
    // SKILL.md). Returning the directory path would cause a directory-import
    // error downstream, so signal "no module" with an empty string.
    return "";
  }

  /**
   * Refresh skill cache (force reload)
   */
  refreshCache(): void {
    this.searchEngine.clearCache();
  }

  /**
   * Get skill statistics
   */
  async getStats(): Promise<{
    totalSkills: number;
    categories: string[];
    loadedSkills: number;
    availableTags: string[];
  }> {
    const allSkills = await this.searchEngine.listAll();
    const categories = await this.searchEngine.getCategories();
    const tags = await this.searchEngine.getTags();

    return {
      totalSkills: allSkills.length,
      categories,
      loadedSkills: this.loadedSkills.size,
      availableTags: tags,
    };
  }
}

/**
 * Singleton instance for global access
 */
let skillLoader: SkillLoader | null = null;

export function initSkillLoader(paths: RuntimePaths | string): SkillLoader {
  skillLoader = new SkillLoader(paths);
  return skillLoader;
}

export function getSkillLoader(): SkillLoader {
  if (!skillLoader) {
    throw new Error(
      "SkillLoader not initialized. Call initSkillLoader() first.",
    );
  }
  return skillLoader;
}

export default SkillLoader;
