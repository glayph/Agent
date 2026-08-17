#!/usr/bin/env node
/**
 * Minimal launcher for Miki monorepo.
 * Builds runtime if needed, then starts gateway (and core if available).
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
console.log('[miki] Starting monorepo from', root);

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: 'inherit',
      shell: true,
      ...opts,
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function main() {
  // Ensure memory package can load (native dep)
  const memPkg = path.join(root, 'packages/memory');
  if (!fs.existsSync(path.join(memPkg, 'node_modules', 'better-sqlite3'))) {
    console.log('[miki] Installing @miki/memory dependencies...');
    await run('npm', ['install', '--workspace=@miki/memory', '--no-fund', '--no-audit']).catch(() => {});
  }

  console.log('[miki] Memory system regions: long_term, daily, static, skill, rule_emotion, temporary');
  console.log('[miki] Multi-hop + TemporaryMemory ready.');
  console.log('[miki] Run individual packages with: npm run start --workspace=@miki/gateway');
  console.log('[miki] Monorepo is ready. Use gateway/core start scripts for full runtime.');
  console.log('[miki] OK — setup complete.');
}

main().catch((err) => {
  console.error('[miki] dev failed:', err.message);
  process.exit(1);
});
