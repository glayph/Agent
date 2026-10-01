import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

/**
 * Upgrade step 03, acceptance criterion: every model call goes through the
 * ModelRouter — there is no hard-coded provider call elsewhere in core.
 *
 * This is a static guard. It scans the non-test sources of packages/core/src
 * for the only ways to reach a provider and fails if one appears outside the
 * small allowlist below.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../..");

/** Files that legitimately own a provider boundary, with the reason. */
const ALLOWED: Record<string, string> = {
  "llm/model-router/router.ts": "the router itself — the single caller of providers.complete()",
  "llm/provider/registry.ts": "defines ProviderRegistry.complete (what the router calls)",
  "llm/provider/sdk/registry.ts": "defines ProviderPluginRegistry.complete (below the registry)",
  "llm/provider/openai-compatible-adapter.ts": "vendor transport owned by the provider layer",
  "llm/provider/transport.ts": "OpenAI client factory used by the adapter",
  "llm/provider/completion-health.ts": "credential/health PROBE (launcher 'test connection'), not an agent model call",
  "llm/provider/tool-health.ts": "tool-call capability PROBE, not an agent model call",
};

const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: "providerRegistry.complete(", pattern: /\bproviderRegistry\s*\.\s*complete\s*\(/ },
  { name: "pluginRegistry.complete(", pattern: /\bpluginRegistry\s*\.\s*complete\s*\(/ },
  { name: "this.providers.complete(", pattern: /\bthis\.providers\.complete\s*\(/ },
  { name: "chat.completions.create(", pattern: /\.chat\.completions\.create\s*\(/ },
  { name: "new OpenAI(", pattern: /\bnew\s+OpenAI\s*\(/ },
  { name: "direct /chat/completions fetch", pattern: /\/chat\/completions/ },
];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "__mocks__", "__tests__", "vendor"].includes(entry.name)) continue;
      sources(full, out);
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name) && !/\.(test|spec)\.|\.d\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("model-call boundary (step 03)", () => {
  const files = sources(SRC);

  it("scans a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no source outside the provider layer calls a provider directly", () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (ALLOWED[rel]) continue;
      const text = stripComments(fs.readFileSync(file, "utf8"));
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(text)) violations.push(`${rel}: ${rule.name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("every allowlisted file still exists (stale entries must be removed)", () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(fs.existsSync(path.join(SRC, rel))).toBe(true);
    }
  });

  it("the agent loop calls models only via the router (no achatCompletion import in agent.ts)", () => {
    const agent = fs.readFileSync(path.join(SRC, "agent.ts"), "utf8");
    expect(agent).not.toMatch(/\bachatCompletion\b/);
    expect(agent).toMatch(/this\.modelRouter\.complete\(/);
  });

  it("achatCompletion is a thin wrapper over the default router", () => {
    const llm = fs.readFileSync(path.join(SRC, "llm.ts"), "utf8");
    expect(llm).toMatch(/getDefaultModelRouter\(\)\s*\.complete\(/);
    expect(llm).not.toMatch(/providerRegistry\s*\.\s*complete/);
  });
});
