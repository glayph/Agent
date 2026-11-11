#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...parts) => path.join(root, ...parts);
const exists = (...parts) => fs.existsSync(at(...parts));

// Memory has one package owner; Core must not retain a parallel implementation folder.
for (const legacy of ['packages/core/src/memory-file', 'packages/core/src/memory-files', 'packages/core/src/memory']) {
  assert.equal(exists(...legacy.split('/')), false, `Legacy Core memory directory remains: ${legacy}`);
}
assert.ok(exists('packages/memory/src/core/index.ts'), 'TKG memory implementation is missing');
assert.ok(exists('packages/memory/src/file-memory/index.ts'), 'File-memory implementation is missing');
const memoryManifest = JSON.parse(fs.readFileSync(at('packages/memory/package.json'), 'utf8'));
assert.ok(memoryManifest.exports?.['./file-memory'], '@miki/memory/file-memory export is missing');

// llama.cpp is a built-in provider with its complete CMake source under one folder.
const llamaRoot = ['packages', 'core', 'src', 'plugins', 'providers', 'builtin', 'llama.cpp'];
assert.ok(exists(...llamaRoot, 'source', 'CMakeLists.txt'), 'Vendored llama.cpp CMake source is missing');
assert.ok(exists(...llamaRoot, 'runtime', 'local-runtime.ts'), 'llama.cpp runtime manager is missing');
assert.ok(exists(...llamaRoot, 'index.ts'), 'llama.cpp provider plugin is missing');
assert.ok(exists('packages/core/src/plugins/providers/llm-client.ts'), 'Provider transport must live under plugins/providers');
assert.equal(exists('packages/core/src/engine/llm-client.ts'), false, 'Provider HTTP transport must not remain under engine');
for (const legacy of [
  'packages/core/src/llm',
  'packages/core/src/plugins/providers/llama-cpp',
  'packages/core/src/plugins/providers/builtin/llama-cpp',
]) {
  assert.equal(exists(...legacy.split('/')), false, `Legacy llama/provider path remains: ${legacy}`);
}

// Every Core build must execute the source build. Turbo cannot cache away the native build side effect.
const coreManifest = JSON.parse(fs.readFileSync(at('packages/core/package.json'), 'utf8'));
assert.equal(coreManifest.scripts?.build, "node ../../scripts/build-llama.mjs && tsc -p tsconfig.json && node scripts/build-skill-catalog.mjs");
const turbo = JSON.parse(fs.readFileSync(at('turbo.json'), 'utf8'));
assert.equal(turbo.tasks?.['@miki/core#build']?.cache, false, 'Turbo must not skip the Core native build');
const buildScript = fs.readFileSync(at('scripts/build-llama.mjs'), 'utf8');
assert.match(buildScript, /builtin[\s\S]{0,100}llama\.cpp[\s\S]{0,100}source/);
assert.match(buildScript, /--target[\s\S]{0,80}llama-server/);
const rootManifest = JSON.parse(fs.readFileSync(at('package.json'), 'utf8'));
assert.ok(rootManifest.scripts?.['build:all']?.includes('npm run build --workspace=@miki/core'), 'Full Agent build must include Core');
assert.match(fs.readFileSync(at('scripts/build-standard.mjs'), 'utf8'), /build-llama\.mjs/);
assert.match(fs.readFileSync(at('scripts/build-release-artifacts.mjs'), 'utf8'), /build-llama\.mjs/);
// Skills catalog, manager and installer are a single Core plugin; Gateway tools are plugin modules.
assert.ok(exists('packages/core/src/plugins/skills/catalog/index.ts'), 'Bundled skill catalog must live inside the Core skills plugin');
assert.ok(exists('packages/core/src/plugins/skills/manager/index.ts'), 'Skills manager must live inside the Core skills plugin');
assert.ok(exists('packages/core/src/plugins/skills/installer/src/index.ts'), 'Skill installer must live inside the Core skills plugin');
assert.equal(exists('packages/core/src/skills-manager'), false, 'Legacy Core skills-manager directory must be removed');
assert.equal(exists('packages/skills'), false, 'Standalone skills workspace must be removed');
assert.equal(exists('packages/installer'), false, 'Standalone installer workspace must be removed');
assert.ok(exists('packages/core/src/plugins/tools/index.ts'), 'Canonical Agent tool implementations must live under Core plugins/tools');
assert.ok(exists('packages/core/src/plugins/tools/terminal-tool.ts'), 'Terminal tool implementation must live under Core plugins/tools');
assert.ok(exists('packages/gateway/src/plugins/tools/terminal-tool.ts'), 'Gateway compatibility tool entrypoint must remain available');
assert.equal(exists('packages/ui/backend'), false, 'Obsolete UI backend directory must be removed');
assert.match(fs.readFileSync(at('.github/workflows/release-offline-cross-platform.yml'), 'utf8'), /packages\/ui\/legacy-go-compat && go build/, 'Release workflow must use the relocated Go compatibility stub');
assert.equal(exists('packages/gateway/src/tools'), false, 'Legacy Gateway tools directory must be removed');
assert.ok(exists('packages/ui/frontend/src/features/agent/plugins/skills/skills-page.tsx'), 'Frontend skills UI must be nested under the plugin feature');
assert.ok(exists('packages/ui/frontend/src/features/agent/plugins/tools/tools-page.tsx'), 'Frontend tools UI must be nested under the plugin feature');
assert.equal(exists('packages/ui/frontend/src/features/agent/skills'), false, 'Legacy frontend skills feature folder must be removed');
assert.equal(exists('packages/ui/frontend/src/features/agent/tools'), false, 'Legacy frontend tools feature folder must be removed');
assert.equal(coreManifest.dependencies?.['@miki/installer'], undefined, 'Core must not depend on a standalone installer workspace');
assert.equal(coreManifest.dependencies?.['@miki/skills'], undefined, 'Core must not depend on a standalone skills workspace');
const skillPluginBarrel = fs.readFileSync(at('packages/core/src/plugins/skills/index.ts'), 'utf8');
assert.match(skillPluginBarrel, /manager\/index/);
assert.match(skillPluginBarrel, /installer\/src\/index/);
assert.match(skillPluginBarrel, /catalog\/index/);
const memoryTestScript = memoryManifest.scripts?.test ?? '';
assert.ok(memoryTestScript.includes('test:file-memory'), 'Memory workspace test command must run the moved file-memory tests');

// The only Gateway-side provider registry access must be inside ProviderGateway.
const gatewayRoot = at('packages/gateway/src');
const providerRegistryUsages = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:[cm]?ts|tsx|js|mjs)$/.test(entry.name)) {
      const content = fs.readFileSync(file, 'utf8');
      if (/\bproviderRegistry\b/.test(content)) providerRegistryUsages.push(path.relative(root, file));
    }
  }
}
walk(gatewayRoot);
assert.deepEqual(providerRegistryUsages, ['packages/gateway/src/providers/provider-gateway.ts']);
const gatewayComposition = fs.readFileSync(at('packages/gateway/src/index.ts'), 'utf8');
assert.doesNotMatch(gatewayComposition, /import\s*\{[^}]*\b(?:configureLocalModels|synchronizeLocalRuntimeForModel)\b[^}]*\}\s*from\s*['\"]@miki\/core\/plugins['\"]/s, 'Gateway composition must not import local-provider lifecycle directly');
assert.match(gatewayComposition, /providerGateway\.configureLocalModels/);
assert.match(gatewayComposition, /providerGateway\.synchronizeLocalRuntimeForModel/);
assert.doesNotMatch(fs.readFileSync(at('packages/core/src/plugins/index.ts'), 'utf8'), /configureLocalModels|synchronizeLocalRuntimeForModel/, 'Generic plugin barrel must not bypass ProviderGateway for provider lifecycle');

console.log('architecture-layout-contract: PASS');
