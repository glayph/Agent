import fs from 'node:fs'
import assert from 'node:assert/strict'

const read = (p) => fs.readFileSync(p, 'utf8')
const engine = read('packages/core/src/engine/agent-engine.ts')
const skills = read('packages/core/src/engine/skill-tools.ts')
const runtime = read('packages/gateway/src/agent-runtime.ts')
const gateway = read('packages/gateway/src/index.ts')
const evolution = read('packages/gateway/src/dashboard-extended.ts')
const pkg = JSON.parse(read('packages/core/package.json'))

// Tool feedback
assert.match(runtime, /getToolFeedbackConfig/)
assert.match(runtime, /cfg\.enabled/)
assert.match(runtime, /cfg\.separateMessages/)
assert.match(runtime, /cfg\.maxArgsLength/)
assert.match(gateway, /tool_feedback/)

// Summarize: settings must reach the actual CompactionManager on every chat turn.
assert.match(gateway, /FileMemoryService/)
assert.match(gateway, /fileMemory\.updateConfig/)
assert.match(gateway, /fileMemory\.compaction\.compact/)
assert.match(gateway, /compacted\.messages/)
assert.match(gateway, /summarize_token_percent/)
assert.match(gateway, /summarize_message_threshold/)
assert.match(gateway, /getLifecycleBus\(\)\.emit\("message:sent"/)
assert.match(gateway, /surface: "webchat"/)

// System prompt OFF must remove generated system prompt, not merely blank its base.
assert.match(engine, /configuredSystemPrompt\s*\n\s*\?\s*\{/)
assert.match(engine, /\.\.\.\(systemMessage \? \[systemMessage\] : \[\]\)/)
assert.match(engine, /configuredSystemPrompt \? promptHistory\.filter\(\(message\) => message\.role === "system"\)/)

// Skills: off/custom must affect both prompt context and actual skill operations.
assert.match(runtime, /allowedSkills:/)
assert.match(runtime, /mode === "off"/)
assert.match(runtime, /mode === "custom"/)
assert.match(runtime, /Installed skills enabled for this turn/)
assert.match(skills, /allowedSkills\?: \(\) => string\[\] \| undefined/)
assert.match(skills, /requireAllowed\(name\)/)

// Evolution state directory must cause engine recreation when changed.
assert.match(evolution, /const stateDir = String\(\(asRecord\(deps\.getAppConfig\(\)\.evolution\)\.state_dir \|\| deps\.dataRoot\)\)/)
assert.match(evolution, /JSON\.stringify\(\{ config, stateDir \}\)/)
assert.match(evolution, /message:sent/)
assert.match(evolution, /monitor_usb/)

assert.ok(pkg.exports['./memory-files'], 'core memory-files subpath export missing')
assert.match(evolution, /diffUsbDevices|scanLinuxUsbDevices/)
console.log('p1-runtime-contract: PASS')
