"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const LearningStore = require("../learning-store");
const TemporalKnowledgeGraph = require("../temporal-knowledge-graph");

function makeScope(workspaceId = "workspace-a") {
  return { agentId: "miki", ownerId: "owner-a", workspaceId };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-learning-"));
  const dbPath = path.join(dir, "memory.db");
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  const store = new LearningStore(db);
  store.initializeSync();

  const first = store.recordExperience({
    scope: makeScope(),
    runId: "run-1",
    taskClass: "simple",
    contextSummary: "stable arithmetic request",
    actionKey: "baseline",
    actionPayload: { apiKey: 'sk-test-secret-value-123456789', actionKey: 'model:gemini/test' },
    outcome: "success",
    reward: 1.5,
    rewardComponents: { taskSuccess: 1 },
    idempotencyKey: "run-1:turn-1",
  });
  assert.strictEqual(first.stored, true);
  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(first.row.reward, 1);
  assert.strictEqual(first.row.actionPayload.apiKey, '<REDACTED_SECRET>');
  assert.strictEqual(first.row.actionPayload.actionKey, 'model:gemini/test');

  const duplicate = store.recordExperience({
    scope: makeScope(),
    actionKey: "unsafe-change",
    outcome: "failure",
    reward: -1,
    idempotencyKey: "run-1:turn-1",
  });
  assert.strictEqual(duplicate.stored, false);
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual(store.listExperiences(makeScope()).length, 1);

  const otherScope = store.recordExperience({
    scope: makeScope("workspace-b"),
    actionKey: "baseline",
    outcome: "success",
    reward: 0.5,
    idempotencyKey: "run-1:turn-1",
  });
  assert.strictEqual(otherScope.stored, true);
  assert.strictEqual(store.listExperiences(makeScope()).length, 1);
  assert.strictEqual(store.listExperiences(makeScope("workspace-b")).length, 1);

  const policy = store.upsertPolicyState(makeScope(), {
    mode: "draft",
    policyVersion: 2,
    totalDecisions: 3,
    averageReward: 0.4,
    actionStats: { baseline: { count: 3, averageReward: 0.4 } },
  });
  assert.strictEqual(policy.mode, "draft");
  assert.strictEqual(policy.policyVersion, 2);
  assert.strictEqual(store.readPolicyState(makeScope()).totalDecisions, 3);

  const cycle = store.startCycle(makeScope(), "reflection");
  assert.strictEqual(
    store.lastCycle(makeScope(), "reflection").status,
    "running",
  );
  assert.strictEqual(
    store.finishCycle(cycle.id, {
      status: "completed",
      inputCount: 1,
      outputCount: 1,
    }).status,
    "completed",
  );

  const proposal = store.createProposal({
    scope: makeScope(),
    kind: "policy",
    payload: { prompt: "safe baseline" },
    evidenceIds: [first.row.id],
    driftPercent: 2,
  });
  assert.strictEqual(proposal.status, "draft");
  assert.strictEqual(
    store.updateProposal(makeScope(), proposal.id, {
      status: "pending_approval",
    }).status,
    "pending_approval",
  );

  db.close();

  const tkgPath = path.join(dir, "tkg.db");
  const tkg = new TemporalKnowledgeGraph(tkgPath);
  tkg.initializeSync();
  assert.ok(tkg.learningStore, "TKG must expose an initialized learning store");
  const persisted = new Database(tkgPath, { readonly: true });
  const tableNames = persisted
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  for (const table of [
    "learning_experiences",
    "learning_policy_state",
    "improvement_cycles",
    "improvement_proposals",
  ]) {
    assert.ok(tableNames.includes(table), `missing ${table}`);
  }
  persisted.close();
  tkg.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("LearningStore tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
