#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const directory = process.argv[2] || process.env.MIKI_TEST_OUTPUT || "test-results";
const minimumChars = Math.max(1, Number(process.env.MIKI_MIN_RESPONSE_CHARS || 160));
const failureMarkers = [
  "provider ",
  "request failed",
  "rate limit",
  "rate-limited",
  "invalid auth",
  "does not exist",
  "cannot read",
  "can't read",
  "exceeded max consecutive",
  "request rejected",
  "timed out",
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function evaluate(record) {
  const text = typeof record.responseText === "string" ? record.responseText.trim() : "";
  const lower = text.toLowerCase();
  const errors = [];
  if (record.runEnd?.status !== "completed") errors.push(`runEnd=${record.runEnd?.status || "missing"}`);
  if (text.length < minimumChars) errors.push(`responseChars=${text.length}<${minimumChars}`);
  if (failureMarkers.some((marker) => lower.includes(marker))) errors.push("failure-marker-in-response");
  if (!record.runEnd) errors.push("missing-runEnd");
  return { id: record.id || "unknown", pass: errors.length === 0, responseChars: text.length, errors };
}

if (!fs.existsSync(directory)) {
  console.error(`quality gate input does not exist: ${directory}`);
  process.exit(2);
}
const files = fs.readdirSync(directory).filter((file) => file.endsWith(".json") && file !== "summary.json");
const results = files.map((file) => evaluate(readJson(path.join(directory, file))));
const summary = {
  checkedAt: new Date().toISOString(),
  directory: path.resolve(directory),
  minimumChars,
  total: results.length,
  passed: results.filter((item) => item.pass).length,
  failed: results.filter((item) => !item.pass).length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.failed === 0 && summary.total > 0 ? 0 : 1;
