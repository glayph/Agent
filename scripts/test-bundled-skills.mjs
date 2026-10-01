#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { SkillSearchEngine } from "../packages/core/dist/skill-search.js";
import { SkillLoader } from "../packages/core/dist/skill-loader.js";
import { normalizeRuntimePaths } from "../packages/core/dist/paths.js";
import { bundledSkillsRoot } from "@miki/skills";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const catalogRoot = bundledSkillsRoot();
if (!fs.existsSync(catalogRoot)) {
  throw new Error(`Bundled skills catalog is missing: ${catalogRoot}`);
}

const runtimePaths = normalizeRuntimePaths(root);
const search = new SkillSearchEngine(runtimePaths);
const discovered = await search.listAll(true);
const loader = new SkillLoader(runtimePaths);
const metadata = await loader.getAllSkillsMetadata();

const minimumBundledSkills = 30;
if (discovered.length < minimumBundledSkills) {
  throw new Error(
    `Bundled skill discovery found ${discovered.length} skills; expected at least ${minimumBundledSkills}. Catalog: ${catalogRoot}`,
  );
}
if (metadata.length !== discovered.length) {
  throw new Error(
    `SkillLoader/search mismatch: loader=${metadata.length}, search=${discovered.length}`,
  );
}
for (const id of [
  "ai-collaboration/accessibility",
  "software-development/systematic-debugging",
  "research/arxiv",
]) {
  if (!discovered.some((skill) => skill.id === id)) {
    throw new Error(`Required bundled skill was not discovered: ${id}`);
  }
}

console.log(
  `PASS bundled skills discovery (${discovered.length} skills) from ${catalogRoot}`,
);
