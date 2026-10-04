/**
 * Durable agent runs store + HTTP router.
 * Every AgentEngine completion (chat, heartbeat, autonomy, control) is persisted
 * so /agent/runs and swarm/agents status reflect real history instead of stubs.
 */
import Database from "better-sqlite3";
import { Router } from "express";

import { getErrorMessage } from "../errors.js";

export type AgentRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "limit_reached";

export type AgentRunLane = "chat" | "heartbeat" | "autonomy" | "control";

export interface AgentRunRow {
  id: string;
  session_id: string | null;
  lane: AgentRunLane;
  source: string;
  status: AgentRunStatus;
  model: string | null;
  goal: string | null;
  final_text: string | null;
  error: string | null;
  turns: number;
  tool_calls: number;
  usage_prompt_tokens: number;
  usage_completion_tokens: number;
  usage_total_tokens: number;
  started_at: string;
  finished_at: string | null;
  created_at: string;
}

export interface AgentRunListFilter {
  status?: string;
  lane?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface AgentRunCreateInput {
  id: string;
  sessionId?: string;
  lane?: AgentRunLane;
  source: string;
  model?: string;
  goal?: string;
  startedAt?: string;
}

export interface AgentRunFinishInput {
  status: AgentRunStatus;
  model?: string;
  goal?: string;
  finalText?: string;
  error?: string;
  turns?: number;
  toolCalls?: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  finishedAt?: string;
}

function mapSourceToLane(source: string): AgentRunLane {
  const s = source.toLowerCase();
  if (s.includes("heartbeat")) return "heartbeat";
  if (s.includes("autonomy") || s.includes("objective") || s.includes("self"))
    return "autonomy";
  if (s.includes("api-test") || s.includes("control") || s.includes("system"))
    return "control";
  return "chat";
}

/** SQLite store for agent engine runs (chat + autonomy lanes). */
export class RunsStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        lane TEXT NOT NULL DEFAULT 'chat',
        source TEXT NOT NULL DEFAULT 'unknown',
        status TEXT NOT NULL DEFAULT 'running',
        model TEXT,
        goal TEXT,
        final_text TEXT,
        error TEXT,
        turns INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        usage_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        usage_completion_tokens INTEGER NOT NULL DEFAULT 0,
        usage_total_tokens INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_lane ON agent_runs(lane);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC);
    `);
  }

  create(input: AgentRunCreateInput): AgentRunRow {
    const now = input.startedAt ?? new Date().toISOString();
    const lane = input.lane ?? mapSourceToLane(input.source);
    this.db
      .prepare(
        `INSERT INTO agent_runs
           (id, session_id, lane, source, status, model, goal, started_at, created_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId ?? null,
        lane,
        input.source,
        input.model ?? null,
        input.goal ?? null,
        now,
        now,
      );
    return this.get(input.id)!;
  }

  finish(id: string, input: AgentRunFinishInput): AgentRunRow | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const finishedAt = input.finishedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_runs SET
           status = ?,
           model = COALESCE(?, model),
           goal = COALESCE(?, goal),
           final_text = ?,
           error = ?,
           turns = ?,
           tool_calls = ?,
           usage_prompt_tokens = ?,
           usage_completion_tokens = ?,
           usage_total_tokens = ?,
           finished_at = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.model ?? null,
        input.goal ?? null,
        input.finalText ?? null,
        input.error ?? null,
        input.turns ?? 0,
        input.toolCalls ?? 0,
        input.usage?.promptTokens ?? 0,
        input.usage?.completionTokens ?? 0,
        input.usage?.totalTokens ?? 0,
        finishedAt,
        id,
      );
    return this.get(id);
  }

  get(id: string): AgentRunRow | undefined {
    return this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as
      | AgentRunRow
      | undefined;
  }

  list(filter: AgentRunListFilter = {}): {
    runs: AgentRunRow[];
    total: number;
  } {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.status && filter.status !== "all") {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.lane && filter.lane !== "all") {
      clauses.push("lane = ?");
      params.push(filter.lane);
    }
    if (filter.q && filter.q.trim()) {
      clauses.push(
        "(lower(goal) LIKE ? OR lower(final_text) LIKE ? OR lower(source) LIKE ? OR lower(id) LIKE ? OR lower(error) LIKE ?)",
      );
      const needle = `%${filter.q.trim().toLowerCase()}%`;
      params.push(needle, needle, needle, needle, needle);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM agent_runs ${where}`)
        .get(...params) as { c: number }
    ).c;

    const runs = this.db
      .prepare(
        `SELECT * FROM agent_runs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as AgentRunRow[];

    return { runs, total };
  }

  /** Active (running) counts by lane — used by swarm/agents status. */
  activeByLane(): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT lane, COUNT(*) AS c FROM agent_runs WHERE status = 'running' GROUP BY lane",
      )
      .all() as Array<{ lane: string; c: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.lane] = row.c;
    return out;
  }

  recent(limit = 10): AgentRunRow[] {
    return this.db
      .prepare("SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as AgentRunRow[];
  }

  stats(): {
    total: number;
    byStatus: Record<string, number>;
    byLane: Record<string, number>;
  } {
    const total = (
      this.db.prepare("SELECT COUNT(*) AS c FROM agent_runs").get() as {
        c: number;
      }
    ).c;
    const byStatusRows = this.db
      .prepare("SELECT status, COUNT(*) AS c FROM agent_runs GROUP BY status")
      .all() as Array<{ status: string; c: number }>;
    const byLaneRows = this.db
      .prepare("SELECT lane, COUNT(*) AS c FROM agent_runs GROUP BY lane")
      .all() as Array<{ lane: string; c: number }>;
    const byStatus: Record<string, number> = {};
    const byLane: Record<string, number> = {};
    for (const r of byStatusRows) byStatus[r.status] = r.c;
    for (const r of byLaneRows) byLane[r.lane] = r.c;
    return { total, byStatus, byLane };
  }
}

function toPublic(row: AgentRunRow) {
  return {
    id: row.id,
    session_id: row.session_id,
    lane: row.lane,
    source: row.source,
    status: row.status,
    model: row.model,
    goal: row.goal,
    final_text: row.final_text,
    error: row.error,
    turns: row.turns,
    tool_calls: row.tool_calls,
    usage: {
      prompt_tokens: row.usage_prompt_tokens,
      completion_tokens: row.usage_completion_tokens,
      total_tokens: row.usage_total_tokens,
    },
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
  };
}

/**
 * HTTP surface for agent runs.
 * Mount at /api/runs (auth required by caller).
 */
export function createRunsRouter(store: RunsStore): Router {
  const router = Router();

  router.get("/", (req, res) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q : undefined;
      const status =
        typeof req.query.status === "string" ? req.query.status : undefined;
      const lane =
        typeof req.query.lane === "string" ? req.query.lane : undefined;
      const limit = Number(req.query.limit || 50);
      const offset = Number(req.query.offset || 0);
      const page = Number(req.query.page || 0);
      const resolvedOffset =
        page > 0 ? (page - 1) * (Number.isFinite(limit) ? limit : 50) : offset;

      const { runs, total } = store.list({
        q,
        status,
        lane,
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(resolvedOffset) ? resolvedOffset : 0,
      });
      res.json({
        runs: runs.map(toPublic),
        total,
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(resolvedOffset) ? resolvedOffset : 0,
      });
    } catch (e: unknown) {
      res.status(500).json({ error: getErrorMessage(e) });
    }
  });

  router.get("/stats", (_req, res) => {
    try {
      res.json(store.stats());
    } catch (e: unknown) {
      res.status(500).json({ error: getErrorMessage(e) });
    }
  });

  router.get("/:id", (req, res) => {
    try {
      const row = store.get(String(req.params.id));
      if (!row) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      res.json(toPublic(row));
    } catch (e: unknown) {
      res.status(500).json({ error: getErrorMessage(e) });
    }
  });

  return router;
}
