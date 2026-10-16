"use strict";

const crypto = require("crypto");

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min = -1, max = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
}

function safeJson(value, fallback = {}) {
  try {
    return JSON.stringify(value == null ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function redactSecrets(value) {
  return String(value == null ? "" : value)
    .replace(/\b(gh[pousr]_[A-Za-z0-9_\-]{20,})\b/g, "<REDACTED_TOKEN>")
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "<REDACTED_TOKEN>")
    .replace(/\b(AQ\.[A-Za-z0-9_-]{20,})\b/g, "<REDACTED_TOKEN>")
    .replace(
      /\b((?:api[_-]?key|token|secret|password|credential|authorization|cookie)\s*[=:]\s*)([^\s,;]{8,})/gi,
      "$1<REDACTED_SECRET>",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1<REDACTED_TOKEN>");
}

function redactPayload(value, depth = 0) {
  if (depth > 6) return "<REDACTED_DEPTH_LIMIT>";
  if (typeof value === "string") return redactSecrets(value).slice(0, 4000);
  if (Array.isArray(value))
    return value.slice(0, 64).map((item) => redactPayload(item, depth + 1));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 128)) {
      if (
        /api[_-]?key|token|secret|password|credential|authorization|cookie/i.test(key)
      ) {
        output[key] = "<REDACTED_SECRET>";
      } else {
        output[key] = redactPayload(item, depth + 1);
      }
    }
    return output;
  }
  return value;
}

class LearningStore {
  constructor(db, options = {}) {
    if (!db || typeof db.prepare !== "function") {
      throw new Error("LearningStore requires a SQLite database");
    }
    this.db = db;
    this.defaultScope = {
      agentId: process.env.MIKI_AGENT_ID || "miki",
      ownerId: process.env.MIKI_OWNER_ID || "default-owner",
      workspaceId: process.env.MIKI_WORKSPACE_ID || "default-workspace",
      ...(options.scope || {}),
    };
    this.initialized = false;
  }

  normalizeScope(scope = {}) {
    const input = { ...this.defaultScope, ...(scope || {}) };
    const agentId =
      String(input.agentId || input.agent_id || "").trim() || "miki";
    const ownerId =
      String(input.ownerId || input.owner_id || "").trim() || "default-owner";
    const workspaceId =
      String(input.workspaceId || input.workspace_id || "").trim() ||
      "default-workspace";
    return {
      agentId,
      ownerId,
      workspaceId,
      scopeKey: `${agentId}:${ownerId}:${workspaceId}`,
    };
  }

  initializeSync() {
    if (this.initialized) return this;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learning_experiences (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        run_id TEXT,
        session_id TEXT,
        task_id TEXT,
        task_class TEXT NOT NULL DEFAULT 'unknown',
        context_hash TEXT NOT NULL,
        context_summary TEXT NOT NULL DEFAULT '',
        action_key TEXT NOT NULL,
        action_payload TEXT NOT NULL DEFAULT '{}',
        outcome TEXT NOT NULL DEFAULT 'unknown',
        reward REAL NOT NULL DEFAULT 0,
        reward_components TEXT NOT NULL DEFAULT '{}',
        model_id TEXT,
        policy_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE(scope_key, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_learning_experiences_scope_time
        ON learning_experiences(scope_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_learning_experiences_scope_action
        ON learning_experiences(scope_key, action_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_learning_experiences_scope_context
        ON learning_experiences(scope_key, context_hash, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_learning_experiences_run
        ON learning_experiences(scope_key, run_id);

      CREATE TABLE IF NOT EXISTS learning_policy_state (
        scope_key TEXT PRIMARY KEY,
        policy_version INTEGER NOT NULL DEFAULT 1,
        mode TEXT NOT NULL DEFAULT 'observe',
        action_stats TEXT NOT NULL DEFAULT '{}',
        total_decisions INTEGER NOT NULL DEFAULT 0,
        average_reward REAL NOT NULL DEFAULT 0,
        baseline_action TEXT,
        updated_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS improvement_cycles (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        cycle_type TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        input_count INTEGER NOT NULL DEFAULT 0,
        output_count INTEGER NOT NULL DEFAULT 0,
        error_redacted TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE(scope_key, cycle_type, started_at)
      );
      CREATE INDEX IF NOT EXISTS idx_improvement_cycles_scope_time
        ON improvement_cycles(scope_key, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_improvement_cycles_scope_type
        ON improvement_cycles(scope_key, cycle_type, started_at DESC);

      CREATE TABLE IF NOT EXISTS improvement_proposals (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        base_policy_version INTEGER NOT NULL DEFAULT 1,
        proposal_payload TEXT NOT NULL DEFAULT '{}',
        evidence_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft',
        drift_percent REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        applied_at TEXT,
        approval_id TEXT,
        rollback_payload TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_improvement_proposals_scope_status
        ON improvement_proposals(scope_key, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_improvement_proposals_scope_time
        ON improvement_proposals(scope_key, created_at DESC);

      CREATE TABLE IF NOT EXISTS learning_decisions (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        context_bucket TEXT NOT NULL,
        context_summary TEXT NOT NULL DEFAULT '',
        candidate_set TEXT NOT NULL DEFAULT '[]',
        chosen_action TEXT NOT NULL,
        propensity REAL NOT NULL DEFAULT 1,
        policy_version INTEGER NOT NULL DEFAULT 1,
        mode TEXT NOT NULL DEFAULT 'observe',
        explored INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_learning_decisions_scope_time
        ON learning_decisions(scope_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_learning_decisions_scope_context
        ON learning_decisions(scope_key, context_bucket, created_at DESC);

      CREATE TABLE IF NOT EXISTS learning_policy_snapshots (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'candidate',
        action_stats TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        promoted_at TEXT,
        retired_at TEXT,
        approval_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE(scope_key, policy_version)
      );
      CREATE INDEX IF NOT EXISTS idx_learning_snapshots_scope_status
        ON learning_policy_snapshots(scope_key, status, policy_version DESC);

      CREATE TABLE IF NOT EXISTS run_retrieved_edges (
        run_id TEXT NOT NULL,
        edge_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        retrieved_at TEXT NOT NULL,
        credited_at TEXT,
        PRIMARY KEY(scope_key, run_id, edge_id)
      );
      CREATE INDEX IF NOT EXISTS idx_run_retrieved_edges_scope_run
        ON run_retrieved_edges(scope_key, run_id);
    `);
    this.initialized = true;
    return this;
  }

  _ensureReady() {
    if (!this.initialized) this.initializeSync();
  }

  _id(prefix) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  recordExperience(input = {}) {
    this._ensureReady();
    const scope = this.normalizeScope(input.scope);
    const idempotencyKey = String(
      input.idempotencyKey || input.idempotency_key || "",
    ).trim();
    if (!idempotencyKey)
      throw new Error("learning experience requires idempotencyKey");
    const createdAt = input.createdAt
      ? new Date(input.createdAt).toISOString()
      : nowIso();
    const payload = redactPayload(
      input.actionPayload || input.action_payload || {},
    );
    const metadata = redactPayload(input.metadata || {});
    const row = {
      id: String(input.id || this._id("lexp")),
      scopeKey: scope.scopeKey,
      runId: input.runId || input.run_id || null,
      sessionId: input.sessionId || input.session_id || null,
      taskId: input.taskId || input.task_id || null,
      taskClass: String(input.taskClass || input.task_class || "unknown").slice(
        0,
        200,
      ),
      contextHash:
        String(input.contextHash || input.context_hash || "").slice(0, 256) ||
        crypto
          .createHash("sha256")
          .update(String(input.contextSummary || ""))
          .digest("hex"),
      contextSummary: redactSecrets(input.contextSummary || "").slice(0, 2000),
      actionKey: String(
        input.actionKey || input.action_key || "baseline",
      ).slice(0, 200),
      actionPayload: safeJson(payload),
      outcome: String(input.outcome || "unknown").slice(0, 120),
      reward: clamp(input.reward, -1, 1),
      rewardComponents: safeJson(
        redactPayload(input.rewardComponents || input.reward_components || {}),
      ),
      modelId:
        input.modelId || input.model_id
          ? String(input.modelId || input.model_id).slice(0, 200)
          : null,
      policyVersion: Math.max(
        1,
        Number(input.policyVersion || input.policy_version || 1) || 1,
      ),
      createdAt,
      idempotencyKey: idempotencyKey.slice(0, 512),
      metadata: safeJson(metadata),
    };
    const insert = this.db.prepare(`
      INSERT INTO learning_experiences
      (id, scope_key, run_id, session_id, task_id, task_class, context_hash, context_summary,
       action_key, action_payload, outcome, reward, reward_components, model_id, policy_version,
       created_at, idempotency_key, metadata)
      VALUES (@id, @scopeKey, @runId, @sessionId, @taskId, @taskClass, @contextHash, @contextSummary,
       @actionKey, @actionPayload, @outcome, @reward, @rewardComponents, @modelId, @policyVersion,
       @createdAt, @idempotencyKey, @metadata)
      ON CONFLICT(scope_key, idempotency_key) DO NOTHING
    `);
    const result = insert.run(row);
    const stored = this.db
      .prepare(
        "SELECT * FROM learning_experiences WHERE scope_key = ? AND idempotency_key = ?",
      )
      .get(scope.scopeKey, row.idempotencyKey);
    return {
      stored: result.changes > 0,
      duplicate: result.changes === 0,
      scope,
      row: this._deserializeExperience(stored),
    };
  }

  recordExperienceAndUpdatePolicy(input = {}) {
    this._ensureReady();
    const transaction = this.db.transaction((payload) => {
      const result = this.recordExperience(payload);
      if (!result.stored) return result;
      const scope = this.normalizeScope(payload.scope);
      const policy = this.readPolicyState(scope);
      const stats = { ...(policy.actionStats || {}) };
      const action = String(payload.actionKey || 'baseline');
      const previous = stats[action] || { count: 0, rewardSum: 0, averageReward: 0, emaReward: 0, variance: 0 };
      const count = Number(previous.count || 0) + 1;
      const reward = Number(payload.reward || 0);
      const oldMean = Number(previous.averageReward || 0);
      const delta = reward - oldMean;
      const emaAlpha = Number(payload.emaAlpha || 0.2);
      const emaReward = Number.isFinite(previous.emaReward) && previous.count > 0
        ? (1 - emaAlpha) * Number(previous.emaReward) + emaAlpha * reward : reward;
      stats[action] = {
        ...previous, count, rewardSum: Number(previous.rewardSum || 0) + reward,
        averageReward: (Number(previous.rewardSum || 0) + reward) / count,
        emaReward, variance: Math.max(0, ((Number(previous.variance || 0) * Math.max(0, count - 1)) + delta * (reward - ((Number(previous.rewardSum || 0) + reward) / count))) / count),
      };
      const total = Number(policy.totalDecisions || 0) + 1;
      const averageReward = (Number(policy.averageReward || 0) * (total - 1) + reward) / total;
      this.upsertPolicyState(scope, { ...policy, actionStats: stats, totalDecisions: total, averageReward });
      return result;
    });
    return transaction(input);
  }

  recordDecision(input = {}) {
    this._ensureReady();
    const scope = this.normalizeScope(input.scope);
    const id = String(input.id || this._id('decision'));
    const candidates = Array.isArray(input.candidates) ? input.candidates.map(String).slice(0, 100) : [];
    this.db.prepare(`INSERT INTO learning_decisions
      (id, scope_key, context_bucket, context_summary, candidate_set, chosen_action, propensity, policy_version, mode, explored, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, scope.scopeKey, String(input.contextBucket || 'default').slice(0, 256), redactSecrets(input.contextSummary || '').slice(0, 1000), safeJson(candidates), String(input.chosenAction || 'baseline'), clamp(Number(input.propensity ?? 1), 0.0001, 1), Math.max(1, Number(input.policyVersion || 1)), String(input.mode || 'observe'), input.explored ? 1 : 0, input.createdAt ? new Date(input.createdAt).toISOString() : nowIso(), safeJson(redactPayload(input.metadata || {})));
    return this.getDecision(scope, id);
  }

  getDecision(scopeInput, id) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const row = this.db.prepare('SELECT * FROM learning_decisions WHERE scope_key = ? AND id = ?').get(scope.scopeKey, String(id));
    if (!row) return null;
    return { id: row.id, scope, contextBucket: row.context_bucket, contextSummary: row.context_summary, candidates: parseJson(row.candidate_set, []), chosenAction: row.chosen_action, propensity: Number(row.propensity), policyVersion: row.policy_version, mode: row.mode, explored: Boolean(row.explored), createdAt: row.created_at, metadata: parseJson(row.metadata, {}) };
  }

  listDecisions(scopeInput, options = {}) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const limit = Math.max(1, Math.min(5000, Number(options.limit || 100)));
    const rows = this.db.prepare('SELECT * FROM learning_decisions WHERE scope_key = ? ORDER BY created_at DESC LIMIT ?').all(scope.scopeKey, limit);
    return rows.map(row => this.getDecision(scope, row.id));
  }

  createPolicySnapshot(scopeInput, input = {}) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const policy = this.readPolicyState(scope);
    const version = Math.max(Number(policy.policyVersion || 1) + 1, Number(input.policyVersion || 0));
    const id = String(input.id || this._id('snapshot'));
    this.db.prepare(`INSERT INTO learning_policy_snapshots(id, scope_key, policy_version, status, action_stats, created_at, approval_id, metadata) VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?)`)
      .run(id, scope.scopeKey, version, safeJson(redactPayload(input.actionStats || policy.actionStats || {})), nowIso(), input.approvalId || null, safeJson(redactPayload(input.metadata || {})));
    return this.getPolicySnapshot(scope, id);
  }

  getPolicySnapshot(scopeInput, id) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const row = this.db.prepare('SELECT * FROM learning_policy_snapshots WHERE scope_key = ? AND id = ?').get(scope.scopeKey, String(id));
    if (!row) return null;
    return { id: row.id, scope, policyVersion: row.policy_version, status: row.status, actionStats: parseJson(row.action_stats, {}), createdAt: row.created_at, promotedAt: row.promoted_at, retiredAt: row.retired_at, approvalId: row.approval_id, metadata: parseJson(row.metadata, {}) };
  }

  getActivePolicySnapshot(scopeInput) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const row = this.db.prepare("SELECT id FROM learning_policy_snapshots WHERE scope_key = ? AND status = 'active' ORDER BY policy_version DESC LIMIT 1").get(scope.scopeKey);
    return row ? this.getPolicySnapshot(scope, row.id) : null;
  }

  promotePolicySnapshot(scopeInput, id, approvalId) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const tx = this.db.transaction(() => {
      const candidate = this.getPolicySnapshot(scope, id);
      if (!candidate || !['candidate', 'approved', 'retired'].includes(candidate.status)) throw new Error('policy snapshot is not promotable');
      const now = nowIso();
      this.db.prepare("UPDATE learning_policy_snapshots SET status='retired', retired_at=? WHERE scope_key=? AND status='active'").run(now, scope.scopeKey);
      this.db.prepare("UPDATE learning_policy_snapshots SET status='active', promoted_at=?, approval_id=? WHERE scope_key=? AND id=?").run(now, String(approvalId || this._id('approval')), scope.scopeKey, String(id));
      const policy = this.readPolicyState(scope);
      this.upsertPolicyState(scope, { ...policy, policyVersion: candidate.policyVersion, actionStats: candidate.actionStats, metadata: { ...(policy.metadata || {}), activeSnapshotId: id } });
      return this.getPolicySnapshot(scope, id);
    });
    return tx();
  }

  rollbackPolicySnapshot(scopeInput, id) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const target = this.getPolicySnapshot(scope, id);
    if (!target || target.status !== 'retired') throw new Error('retired policy snapshot is required for rollback');
    return this.promotePolicySnapshot(scope, id, `rollback-${this._id('approval')}`);
  }

  recordRetrievedEdges(scopeInput, runId, edgeIds = []) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const insert = this.db.prepare('INSERT OR IGNORE INTO run_retrieved_edges(run_id, edge_id, scope_key, retrieved_at) VALUES (?, ?, ?, ?)');
    const tx = this.db.transaction(ids => { for (const edgeId of ids.slice(0, 500)) insert.run(String(runId), String(edgeId), scope.scopeKey, nowIso()); });
    tx(Array.isArray(edgeIds) ? edgeIds : []);
    return edgeIds.length;
  }

  creditRetrievedEdges(scopeInput, runId, reward, eta = 0.05) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const delta = clamp(Number(eta) * (clamp(Number(reward), -1, 1) - 0), -0.1, 0.1);
    const rows = this.db.prepare('SELECT edge_id FROM run_retrieved_edges WHERE scope_key=? AND run_id=? AND credited_at IS NULL').all(scope.scopeKey, String(runId));
    const update = this.db.prepare('UPDATE entity_edges SET weight = MIN(1.0, MAX(0.05, COALESCE(weight, 1.0) + ?)) WHERE scope_key=? AND id=?');
    const mark = this.db.prepare('UPDATE run_retrieved_edges SET credited_at=? WHERE scope_key=? AND run_id=? AND edge_id=?');
    const tx = this.db.transaction(() => { for (const row of rows) { update.run(delta, scope.scopeKey, row.edge_id); mark.run(nowIso(), scope.scopeKey, String(runId), row.edge_id); } });
    tx();
    return { credited: rows.length, delta };
  }

  pruneExperiences(scopeInput, retentionDays = 90) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const cutoff = new Date(Date.now() - Math.max(1, Number(retentionDays || 90)) * 86400000).toISOString();
    return this.db.prepare('DELETE FROM learning_experiences WHERE scope_key=? AND created_at < ?').run(scope.scopeKey, cutoff).changes;
  }

  listExperiences(scopeInput, options = {}) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const limit = Math.max(1, Math.min(1000, Number(options.limit || 100)));
    const params = [scope.scopeKey];
    let where = "scope_key = ?";
    if (options.actionKey) {
      where += " AND action_key = ?";
      params.push(String(options.actionKey));
    }
    if (options.contextHash) {
      where += " AND context_hash = ?";
      params.push(String(options.contextHash));
    }
    if (options.since) {
      where += " AND created_at >= ?";
      params.push(new Date(options.since).toISOString());
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM learning_experiences WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params, limit);
    return rows.map((row) => this._deserializeExperience(row));
  }

  getExperienceStats(scopeInput, options = {}) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const params = [scope.scopeKey];
    let where = "scope_key = ?";
    if (options.since) {
      where += " AND created_at >= ?";
      params.push(new Date(options.since).toISOString());
    }
    const total = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(AVG(reward), 0) AS average_reward FROM learning_experiences WHERE ${where}`,
      )
      .get(...params);
    const actions = this.db
      .prepare(
        `SELECT action_key, COUNT(*) AS count, COALESCE(AVG(reward), 0) AS average_reward FROM learning_experiences WHERE ${where} GROUP BY action_key ORDER BY average_reward DESC, count DESC`,
      )
      .all(...params);
    const outcomes = this.db
      .prepare(
        `SELECT outcome, COUNT(*) AS count FROM learning_experiences WHERE ${where} GROUP BY outcome ORDER BY count DESC`,
      )
      .all(...params);
    return {
      scope,
      total: Number(total.count),
      averageReward: Number(total.average_reward),
      actions,
      outcomes,
    };
  }

  readPolicyState(scopeInput) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const row = this.db
      .prepare("SELECT * FROM learning_policy_state WHERE scope_key = ?")
      .get(scope.scopeKey);
    if (!row)
      return {
        scope,
        policyVersion: 1,
        mode: "observe",
        actionStats: {},
        totalDecisions: 0,
        averageReward: 0,
        baselineAction: null,
        updatedAt: null,
        metadata: {},
      };
    return {
      scope,
      policyVersion: row.policy_version,
      mode: row.mode,
      actionStats: parseJson(row.action_stats, {}),
      totalDecisions: row.total_decisions,
      averageReward: row.average_reward,
      baselineAction: row.baseline_action,
      updatedAt: row.updated_at,
      metadata: parseJson(row.metadata, {}),
    };
  }

  upsertPolicyState(scopeInput, state = {}) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const current = this.readPolicyState(scope);
    const next = {
      policyVersion: Math.max(
        current.policyVersion,
        Number(state.policyVersion || current.policyVersion) || 1,
      ),
      mode: ["observe", "draft", "apply"].includes(state.mode)
        ? state.mode
        : current.mode,
      actionStats: redactPayload(state.actionStats || current.actionStats),
      totalDecisions: Math.max(
        0,
        Number(state.totalDecisions ?? current.totalDecisions) || 0,
      ),
      averageReward: clamp(state.averageReward ?? current.averageReward, -1, 1),
      baselineAction:
        state.baselineAction == null
          ? current.baselineAction
          : String(state.baselineAction).slice(0, 200),
      updatedAt: nowIso(),
      metadata: redactPayload(state.metadata || current.metadata),
    };
    this.db
      .prepare(
        `
      INSERT INTO learning_policy_state(scope_key, policy_version, mode, action_stats, total_decisions, average_reward, baseline_action, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        policy_version = excluded.policy_version,
        mode = excluded.mode,
        action_stats = excluded.action_stats,
        total_decisions = excluded.total_decisions,
        average_reward = excluded.average_reward,
        baseline_action = excluded.baseline_action,
        updated_at = excluded.updated_at,
        metadata = excluded.metadata
    `,
      )
      .run(
        scope.scopeKey,
        next.policyVersion,
        next.mode,
        safeJson(next.actionStats),
        next.totalDecisions,
        next.averageReward,
        next.baselineAction,
        next.updatedAt,
        safeJson(next.metadata),
      );
    return this.readPolicyState(scope);
  }

  startCycle(scopeInput, cycleType, metadata = {}) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const startedAt = nowIso();
    const id = this._id("cycle");
    this.db
      .prepare(
        `INSERT INTO improvement_cycles(id, scope_key, cycle_type, started_at, status, metadata) VALUES (?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        id,
        scope.scopeKey,
        String(cycleType),
        startedAt,
        safeJson(redactPayload(metadata)),
      );
    return {
      id,
      scope,
      cycleType: String(cycleType),
      startedAt,
      status: "running",
    };
  }

  finishCycle(cycleId, result = {}) {
    this._ensureReady();
    const status = ["completed", "skipped", "degraded", "failed"].includes(
      result.status,
    )
      ? result.status
      : "completed";
    const completedAt = nowIso();
    const updated = this.db
      .prepare(
        `UPDATE improvement_cycles SET completed_at = ?, status = ?, input_count = ?, output_count = ?, error_redacted = ?, metadata = ? WHERE id = ?`,
      )
      .run(
        completedAt,
        status,
        Math.max(0, Number(result.inputCount || 0)),
        Math.max(0, Number(result.outputCount || 0)),
        result.error ? redactSecrets(result.error).slice(0, 1000) : null,
        safeJson(redactPayload(result.metadata || {})),
        cycleId,
      );
    return { updated: updated.changes > 0, cycleId, completedAt, status };
  }

  countCyclesSince(scopeInput, cycleType, since) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const sinceIso = since
      ? new Date(since).toISOString()
      : new Date(0).toISOString();
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM improvement_cycles WHERE scope_key = ? AND cycle_type = ? AND started_at >= ?",
      )
      .get(scope.scopeKey, String(cycleType), sinceIso);
    return Number(row.count || 0);
  }

  lastCycle(scopeInput, cycleType) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const row = this.db
      .prepare(
        "SELECT * FROM improvement_cycles WHERE scope_key = ? AND cycle_type = ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(scope.scopeKey, String(cycleType));
    return row
      ? {
          id: row.id,
          cycleType: row.cycle_type,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          status: row.status,
          inputCount: row.input_count,
          outputCount: row.output_count,
        }
      : null;
  }

  createProposal(input = {}) {
    this._ensureReady();
    const scope = this.normalizeScope(input.scope);
    const id = String(input.id || this._id("proposal"));
    this.db
      .prepare(
        `INSERT INTO improvement_proposals(id, scope_key, kind, base_policy_version, proposal_payload, evidence_ids, status, drift_percent, created_at, approval_id, rollback_payload, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope.scopeKey,
        String(input.kind || "unknown"),
        Math.max(1, Number(input.basePolicyVersion || 1)),
        safeJson(redactPayload(input.payload || {})),
        safeJson(
          Array.isArray(input.evidenceIds)
            ? input.evidenceIds.slice(0, 100)
            : [],
        ),
        [
          "draft",
          "pending_approval",
          "approved",
          "applied",
          "rejected",
          "rolled_back",
        ].includes(input.status)
          ? input.status
          : "draft",
        Math.max(0, Number(input.driftPercent || 0)),
        input.createdAt ? new Date(input.createdAt).toISOString() : nowIso(),
        input.approvalId || null,
        input.rollbackPayload
          ? safeJson(redactPayload(input.rollbackPayload))
          : null,
        safeJson(redactPayload(input.metadata || {})),
      );
    return this.getProposal(scope, id);
  }

  getProposal(scopeInput, proposalId) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const row = this.db
      .prepare(
        "SELECT * FROM improvement_proposals WHERE scope_key = ? AND id = ?",
      )
      .get(scope.scopeKey, String(proposalId));
    if (!row) return null;
    return {
      id: row.id,
      scope,
      kind: row.kind,
      basePolicyVersion: row.base_policy_version,
      payload: parseJson(row.proposal_payload, {}),
      evidenceIds: parseJson(row.evidence_ids, []),
      status: row.status,
      driftPercent: row.drift_percent,
      createdAt: row.created_at,
      appliedAt: row.applied_at,
      approvalId: row.approval_id,
      rollbackPayload: parseJson(row.rollback_payload, null),
      metadata: parseJson(row.metadata, {}),
    };
  }

  updateProposal(scopeInput, proposalId, patch = {}) {
    this._ensureReady();
    const current = this.getProposal(scopeInput, proposalId);
    if (!current) return null;
    const transitions = {
      draft: new Set(["draft", "pending_approval", "rejected"]),
      pending_approval: new Set(["pending_approval", "approved", "rejected"]),
      approved: new Set(["approved", "applied", "rejected"]),
      applied: new Set(["applied", "rolled_back"]),
      rejected: new Set(["rejected"]),
      rolled_back: new Set(["rolled_back"]),
    };
    const requestedStatus = patch.status || current.status;
    if (!Object.prototype.hasOwnProperty.call(transitions, requestedStatus) || !transitions[current.status]?.has(requestedStatus)) {
      throw new Error(`invalid proposal transition: ${current.status} -> ${requestedStatus}`);
    }
    const nextStatus = requestedStatus;
    const appliedAt =
      nextStatus === "applied" && !current.appliedAt
        ? nowIso()
        : current.appliedAt;
    this.db
      .prepare(
        `UPDATE improvement_proposals SET status = ?, applied_at = ?, approval_id = ?, proposal_payload = ?, evidence_ids = ?, drift_percent = ?, rollback_payload = ?, metadata = ? WHERE scope_key = ? AND id = ?`,
      )
      .run(
        nextStatus,
        appliedAt,
        patch.approvalId ?? current.approvalId,
        safeJson(redactPayload(patch.payload || current.payload)),
        safeJson(
          Array.isArray(patch.evidenceIds)
            ? patch.evidenceIds.slice(0, 100)
            : current.evidenceIds,
        ),
        Math.max(0, Number(patch.driftPercent ?? current.driftPercent)),
        patch.rollbackPayload
          ? safeJson(redactPayload(patch.rollbackPayload))
          : current.rollbackPayload
            ? safeJson(current.rollbackPayload)
            : null,
        safeJson(redactPayload(patch.metadata || current.metadata)),
        current.scope.scopeKey,
        String(proposalId),
      );
    return this.getProposal(current.scope, proposalId);
  }

  approveProposal(scopeInput, proposalId, approvalId) {
    return this.updateProposal(scopeInput, proposalId, { status: 'approved', approvalId: String(approvalId || this._id('approval')) });
  }

  applyProposal(scopeInput, proposalId) {
    const proposal = this.getProposal(scopeInput, proposalId);
    if (!proposal || proposal.status !== 'approved') throw new Error('approved proposal is required before apply');
    return this.updateProposal(scopeInput, proposalId, { status: 'applied' });
  }

  rollbackProposal(scopeInput, proposalId) {
    const proposal = this.getProposal(scopeInput, proposalId);
    if (!proposal || proposal.status !== 'applied') throw new Error('applied proposal is required before rollback');
    return this.updateProposal(scopeInput, proposalId, { status: 'rolled_back' });
  }

  listProposals(scopeInput, options = {}) {
    this._ensureReady();
    const scope = this.normalizeScope(scopeInput);
    const limit = Math.max(1, Math.min(200, Number(options.limit || 50)));
    const params = [scope.scopeKey];
    let where = "scope_key = ?";
    if (options.status) {
      where += " AND status = ?";
      params.push(String(options.status));
    }
    return this.db
      .prepare(
        `SELECT id FROM improvement_proposals WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map((row) => this.getProposal(scope, row.id));
  }

  _deserializeExperience(row) {
    if (!row) return null;
    return {
      id: row.id,
      scopeKey: row.scope_key,
      runId: row.run_id,
      sessionId: row.session_id,
      taskId: row.task_id,
      taskClass: row.task_class,
      contextHash: row.context_hash,
      contextSummary: row.context_summary,
      actionKey: row.action_key,
      actionPayload: parseJson(row.action_payload, {}),
      outcome: row.outcome,
      reward: Number(row.reward),
      rewardComponents: parseJson(row.reward_components, {}),
      modelId: row.model_id,
      policyVersion: row.policy_version,
      createdAt: row.created_at,
      idempotencyKey: row.idempotency_key,
      metadata: parseJson(row.metadata, {}),
    };
  }
}

module.exports = LearningStore;
