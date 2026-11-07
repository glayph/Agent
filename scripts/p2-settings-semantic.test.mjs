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
// The setting's runtime effect is an unknown-model context-window reserve, not a
// forced provider output cap. Read the canonical helper rather than an old gateway literal.
assert.match(runtime, /resolveContextWindowTokens/);
assert.doesNotMatch(runtime, /max_completion_tokens/);
assert.match(settings, /defaults\.max_completion_tokens \?\? defaults\.max_tokens/);
assert.match(schema, /max_completion_tokens/);
assert.match(schema, /delete defaults\.max_tokens/);
assert.match(schema, /const EvolutionSchema/);
assert.match(schema, /mode: z\.enum\(\["observe", "draft", "apply"\]\)\.default\("observe"\)/);
// Evolution mode is normalized in the config migration/schema layer and read by the config form.
assert.match(schema, /String\(rawEvolution\.mode\)/);
assert.match(form, /evolutionMode: asString\(evolution\.mode\)/);
assert.match(dashboard, /const trigger = stringValue\(config\.cold_path_trigger\)/);
assert.match(config, /max_completion_tokens: 16384/);
assert.ok(config.includes("evolution:\n  enabled: true\n  mode: apply"));
assert.ok(config.includes("cold_path_trigger: after_turn"));
console.log("[p2-settings-semantic] PASS");
