import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const form = read("packages/ui/frontend/src/features/config/components/form-model.ts");
const page = read("packages/ui/frontend/src/pages/config-page.tsx");
const runtime = read("packages/gateway/src/agent-runtime.ts");
const settings = read("packages/gateway/src/runtime-settings.ts");
const schema = read("packages/config/src/schema.ts");
const dashboard = read("packages/gateway/src/dashboard-extended.ts");
const config = read("config/agent.yaml");

assert.match(form, /max_completion_tokens/);
assert.match(page, /max_completion_tokens: maxCompletionTokens/);
assert.match(runtime, /max_completion_tokens/);
assert.match(settings, /defaults\.max_completion_tokens \?\? defaults\.max_tokens/);
assert.match(schema, /max_completion_tokens/);
assert.match(schema, /delete defaults\.max_tokens/);
assert.match(schema, /const EvolutionSchema/);
assert.match(schema, /mode: z\.enum\(\["observe", "draft", "apply"\]\)\.default\("observe"\)/);
assert.match(dashboard, /stringValue\(rawEvolution\.mode\)/);
assert.match(dashboard, /const mode =/);
assert.match(config, /max_completion_tokens: 16384/);
assert.ok(config.includes("evolution:\n  enabled: true\n  mode: observe"));
console.log("[p2-settings-semantic] PASS");
