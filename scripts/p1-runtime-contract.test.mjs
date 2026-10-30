import fs from 'node:fs'
import assert from 'node:assert/strict'

const read = (p) => fs.readFileSync(p, 'utf8')
const engine = read('packages/core/src/engine/agent-engine.ts')
const skills = read('packages/core/src/engine/skill-tools.ts')
const runtime = read('packages/gateway/src/agent-runtime.ts')
// The chat turn (feedback, compaction, lifecycle events) lives in chat-turn-runner.ts; the websocket handler in index.ts is only an adapter.
const gateway = read('packages/gateway/src/index.ts') + '\n' + read('packages/gateway/src/chat-turn-runner.ts')
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
// USB/device monitoring has no runtime consumer in this repository; the Config UI must not claim otherwise.
assert.doesNotMatch(evolution, /monitor_usb|diffUsbDevices|scanLinuxUsbDevices/)
assert.match(evolution, /trigger === "manual"/)
assert.match(evolution, /trigger !== "scheduled"/)
assert.match(evolution, /router\.post\("\/evolution\/run"/)
assert.match(evolution, /const draftServer = req\.body\?\.config/)

assert.ok(pkg.exports['./memory-files'], 'core memory-files subpath export missing')
console.log('p1-runtime-contract: PASS')
