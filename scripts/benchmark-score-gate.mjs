#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const matrixPath = path.join(root, "benchmark", "score-matrix.json");
const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));

const dimensions = matrix.dimensions;
const products = matrix.products;
const targets = matrix.targets;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

assert(dimensions.length === 10, "Expected exactly 10 benchmark dimensions");
const weightSum = dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
assert(Math.abs(weightSum - 1) < 1e-9, `Weights must sum to 1; received ${weightSum}`);

function scoreProduct(scores) {
  assert(Array.isArray(scores) && scores.length === dimensions.length, "Score vector length mismatch");
  for (const score of scores) {
    assert(Number.isInteger(score) && score >= 1 && score <= 5, `Invalid score: ${score}`);
  }
  const weighted = dimensions.reduce((sum, dimension, index) => sum + scoreAt(scores, index) * dimension.weight, 0);
  return { weightedScore5: Number(weighted.toFixed(3)), percent: Number((weighted * 20).toFixed(1)) };
}

function scoreAt(scores, index) {
  return scores[index];
}

const results = Object.fromEntries(Object.entries(products).map(([name, scores]) => [name, scoreProduct(scores)]));

for (const [targetName, target] of Object.entries(targets)) {
  const actual = scoreProduct(target.scores);
  assert(Math.abs(actual.weightedScore5 - target.expected_weighted_score_5) < 1e-9, `${targetName} weighted target arithmetic drift`);
  assert(Math.abs(actual.percent - target.expected_percent) < 1e-9, `${targetName} percent target arithmetic drift`);
}

const miki = results["Agent Miki"];
const minimum = targets.minimum_80_plus;
const recommended = targets.recommended_buffer;
assert(miki.percent < minimum.expected_percent, "Baseline must remain below the 80% target until gates pass");

const output = {
  generatedAt: new Date().toISOString(),
  rubricVersion: matrix.version,
  dimensions: dimensions.map(({ id, label, weight }) => ({ id, label, weight })),
  results,
  targets: {
    minimum_80_plus: { ...minimum, calculated: scoreProduct(minimum.scores) },
    recommended_buffer: { ...recommended, calculated: scoreProduct(recommended.scores) }
  },
  gateStatus: {
    baselineReproducible: true,
    minimumTargetDefined: true,
    recommendedTargetDefined: true,
    implementationEvidenceRequired: true
  }
};

const json = JSON.stringify(output, null, 2);
if (process.argv.includes("--json")) {
  process.stdout.write(`${json}\n`);
} else {
  console.log(`Agent Miki benchmark baseline: ${miki.weightedScore5}/5 (${miki.percent}%)`);
  console.log(`Minimum target: ${minimum.expected_weighted_score_5}/5 (${minimum.expected_percent}%)`);
  console.log(`Recommended target: ${recommended.expected_weighted_score_5}/5 (${recommended.expected_percent}%)`);
  console.log(`All ${dimensions.length} dimensions and target arithmetic: PASS`);
}

if (process.argv.includes("--write")) {
  const outputPath = path.join(root, "benchmark", "score-gate-output.json");
  fs.writeFileSync(outputPath, `${json}\n`, "utf8");
  console.log(`Wrote ${path.relative(root, outputPath)}`);
}
