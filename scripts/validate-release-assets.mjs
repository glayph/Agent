#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [rootDir, version] = process.argv.slice(2);
if (!rootDir || !version) {
  console.error(
    "Usage: node scripts/validate-release-assets.mjs <directory> <version>",
  );
  process.exit(2);
}

const expected = [
  `agent-miki-linux-x64-offline-${version}.tar.gz`,
  `agent-miki-linux-x64-offline-${version}.tgz`,
  `SHA256SUMS-linux-x64`,
  `agent-miki-linux-arm64-offline-${version}.tar.gz`,
  `agent-miki-linux-arm64-offline-${version}.tgz`,
  `SHA256SUMS-linux-arm64`,
  `agent-miki-windows-x64-offline-${version}.zip`,
  `agent-miki-windows-x64-offline-${version}.tgz`,
  `SHA256SUMS-windows-x64`,
].sort();

function filesUnder(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(target));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}
function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}
function fail(message) {
  console.error(`Release asset validation failed: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(rootDir)) fail(`directory does not exist: ${rootDir}`);
const files = filesUnder(rootDir);
const actual = files.map((file) => path.basename(file)).sort();
if (
  actual.length !== expected.length ||
  actual.some((name, index) => name !== expected[index])
) {
  fail(
    `expected exactly ${expected.length} assets. Missing/unexpected files:\n${actual.join("\n")}`,
  );
}

const byName = new Map(files.map((file) => [path.basename(file), file]));
for (const manifestName of [
  "SHA256SUMS-linux-x64",
  "SHA256SUMS-linux-arm64",
  "SHA256SUMS-windows-x64",
]) {
  const manifest = fs
    .readFileSync(byName.get(manifestName), "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (manifest.length !== 2)
    fail(`${manifestName} must contain exactly two archive checksums`);
  for (const line of manifest) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (!match || !byName.has(path.basename(match[2])))
      fail(`invalid entry in ${manifestName}: ${line}`);
    const archive = path.basename(match[2]);
    if (sha256(byName.get(archive)) !== match[1])
      fail(`checksum mismatch for ${archive}`);
  }
}
console.log(
  `PASS release assets: ${actual.length} exact files and verified SHA256 manifests for ${version}`,
);
