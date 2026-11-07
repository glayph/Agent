import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface ResourceDemand {
  resource: string;
  units?: number;
}

export interface ResourceAcquireOptions {
  /** Higher values are admitted before lower-priority waiters. */
  priority?: number;
  timeoutMs?: number;
  leaseMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  onLost?: (error: Error) => void;
}

export interface GlobalResourceLease {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly resources: readonly ResourceDemand[];
  renew(): boolean;
  release(): void;
}

interface WaiterRow {
  sequence: number;
  waiter_id: string;
  resources_json: string;
  priority: number;
  requested_at: string;
  expires_at: string;
}

/**
 * Cross-process, SQLite-backed resource admission for shared host resources.
 * Multi-resource requests are acquired atomically to avoid browser/computer
 * lock-order deadlocks. Waiters are priority ordered and FIFO among equals.
 */
export class GlobalResourceArbiter {
  private readonly capacities: Record<string, number>;
  private readonly now: () => string;
  private readonly defaultLeaseMs: number;
  private readonly defaultPollMs: number;

  constructor(
    private readonly db: Database.Database,
    options: {
      capacities?: Record<string, number>;
      leaseMs?: number;
      pollMs?: number;
      now?: () => string;
    } = {},
  ) {
    this.capacities = { shared_interactive: 1, ...(options.capacities ?? {}) };
    this.now = options.now ?? (() => new Date().toISOString());
    this.defaultLeaseMs = clampInt(options.leaseMs ?? 60_000, 5_000, 15 * 60_000);
    this.defaultPollMs = clampInt(options.pollMs ?? 150, 20, 2_000);
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS miki_global_resource_waiters (
        waiter_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        resources_json TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_miki_global_resource_waiters_order
        ON miki_global_resource_waiters(priority DESC, requested_at ASC);
      CREATE TABLE IF NOT EXISTS miki_global_resource_leases (
        lease_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        units INTEGER NOT NULL,
        lease_expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(lease_id, resource)
      );
      CREATE INDEX IF NOT EXISTS idx_miki_global_resource_leases_resource
        ON miki_global_resource_leases(resource, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_miki_global_resource_leases_owner
        ON miki_global_resource_leases(owner_id, lease_id);
      CREATE TABLE IF NOT EXISTS miki_global_resource_capacities (
        resource TEXT PRIMARY KEY,
        capacity INTEGER NOT NULL CHECK(capacity >= 1),
        updated_at TEXT NOT NULL
      );
    `);
    const seedCapacity = this.db.prepare(`INSERT INTO miki_global_resource_capacities(resource,capacity,updated_at)
      VALUES(?,?,?) ON CONFLICT(resource) DO NOTHING`);
    for (const [resource, capacity] of Object.entries(this.capacities)) {
      seedCapacity.run(resource, capacity, this.now());
    }
    this.migrateLegacyInteractiveLease();
  }

  setCapacity(resource: string, capacity: number): void {
    const key = resource.trim().slice(0, 100);
    if (!key) throw new Error("A resource key is required.");
    const normalized = clampInt(capacity, 1, 10_000);
    this.capacities[key] = normalized;
    this.db.prepare(`INSERT INTO miki_global_resource_capacities(resource,capacity,updated_at)
      VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET capacity=excluded.capacity,updated_at=excluded.updated_at`)
      .run(key, normalized, this.now());
  }

  async acquire(ownerId: string, demands: ResourceDemand[], options: ResourceAcquireOptions = {}): Promise<GlobalResourceLease> {
    const owner = ownerId.trim();
    if (!owner) throw new Error("A resource lease owner is required.");
    const normalized = normalizeDemands(demands);
    for (const demand of normalized) {
      const capacity = this.capacityFor(demand.resource);
      if (demand.units > capacity) throw new Error(`Resource request ${demand.resource}=${demand.units} exceeds capacity ${capacity}.`);
    }
    if (options.signal?.aborted) throw abortError(options.signal.reason);

    const waiterId = randomUUID();
    const leaseId = randomUUID();
    const requestedAt = this.now();
    const priority = clampInt(Number.isFinite(options.priority) ? Math.trunc(options.priority!) : 0, -10_000, 10_000);
    const requestedTimeoutMs = Number(options.timeoutMs);
    const timeoutMs = options.timeoutMs === undefined || requestedTimeoutMs === 0
      ? 0
      : Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(requestedTimeoutMs))
        : 0;
    const leaseMs = clampInt(options.leaseMs ?? this.defaultLeaseMs, 5_000, 15 * 60_000);
    // Waiters have a renewable liveness lease even when they have no overall
    // deadline. A crashed process must not leave a year-9999 queue row that
    // permanently blocks later owners.
    const waiterLeaseMs = Math.max(15_000, leaseMs * 2);
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    const expiresAt = new Date(Date.parse(requestedAt) + waiterLeaseMs).toISOString();
    this.db.prepare(`INSERT INTO miki_global_resource_waiters(waiter_id,owner_id,resources_json,priority,requested_at,expires_at)
      VALUES(?,?,?,?,?,?)`).run(waiterId, owner, JSON.stringify(normalized), priority, requestedAt, expiresAt);

    let acquired = false;
    try {
      while (!acquired) {
        if (options.signal?.aborted) throw abortError(options.signal.reason);
        const waiterNow = this.now();
        if (timeoutMs > 0 && Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for global resources: ${normalized.map((item) => item.resource).join(", ")}.`);
        const waiterExpiry = new Date(Date.parse(waiterNow) + waiterLeaseMs).toISOString();
        const renewedWaiter = this.db.prepare("UPDATE miki_global_resource_waiters SET expires_at=? WHERE waiter_id=? AND expires_at>?").run(waiterExpiry, waiterId, waiterNow);
        if (renewedWaiter.changes !== 1) throw new Error(`Global resource waiter ${waiterId} lost its liveness lease before acquiring resources.`);
        acquired = this.tryAcquire(waiterId, leaseId, owner, normalized, leaseMs);
        if (acquired) break;
        const pollMs = options.pollMs ?? this.defaultPollMs;
        await wait(timeoutMs > 0 ? Math.min(pollMs, Math.max(1, deadline - Date.now())) : pollMs, options.signal);
      }
    } catch (error) {
      this.db.prepare("DELETE FROM miki_global_resource_waiters WHERE waiter_id=?").run(waiterId);
      if (acquired) this.db.prepare("DELETE FROM miki_global_resource_leases WHERE lease_id=?").run(leaseId);
      throw error;
    }

    let released = false;
    let lost = false;
    let heartbeatFailures = 0;
    let leaseDeadline = Date.now() + leaseMs;
    const notifyLost = (message: string) => {
      if (lost || released) return;
      lost = true;
      clearInterval(heartbeat);
      try { options.onLost?.(new Error(message)); } catch { /* A consumer callback must not crash the heartbeat loop. */ }
    };
    const heartbeat = setInterval(() => {
      if (released) return;
      try {
        if (!renew()) {
          notifyLost(`Global resource lease ${leaseId} was lost; the owning run must stop before further shared-resource actions.`);
        } else {
          heartbeatFailures = 0;
          leaseDeadline = Date.now() + leaseMs;
        }
      } catch {
        heartbeatFailures += 1;
        if (Date.now() >= leaseDeadline || heartbeatFailures >= 3) {
          notifyLost(`Global resource lease ${leaseId} could not be renewed before its fencing deadline.`);
        }
      }
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    heartbeat.unref?.();

    const renew = (): boolean => {
      if (released || lost) return false;
      const timestamp = this.now();
      const expires = new Date(Date.parse(timestamp) + leaseMs).toISOString();
      const tx = this.db.transaction(() => {
        const count = Number((this.db.prepare("SELECT COUNT(*) AS count FROM miki_global_resource_leases WHERE lease_id=? AND lease_expires_at>?").get(leaseId, timestamp) as { count: number }).count);
        if (count !== normalized.length) return false;
        const result = this.db.prepare("UPDATE miki_global_resource_leases SET lease_expires_at=?,updated_at=? WHERE lease_id=? AND lease_expires_at>?").run(expires, timestamp, leaseId, timestamp);
        return result.changes === normalized.length;
      });
      return Boolean(tx.immediate());
    };

    return {
      leaseId,
      ownerId: owner,
      resources: normalized,
      renew,
      release: () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        this.db.prepare("DELETE FROM miki_global_resource_leases WHERE lease_id=? AND owner_id=?").run(leaseId, owner);
      },
    };
  }

  snapshot(): { activeLeases: number; waiting: number; oldestWaiterAgeMs: number; byResource: Array<{ resource: string; units: number; capacity: number }> } {
    const timestamp = this.now();
    this.db.prepare("DELETE FROM miki_global_resource_leases WHERE lease_expires_at<=?").run(timestamp);
    this.db.prepare("DELETE FROM miki_global_resource_waiters WHERE expires_at<=?").run(timestamp);
    const leases = this.db.prepare("SELECT COUNT(DISTINCT lease_id) AS count FROM miki_global_resource_leases WHERE lease_expires_at>?").get(timestamp) as { count: number };
    const waiting = this.db.prepare("SELECT COUNT(*) AS count,MIN(requested_at) AS oldest FROM miki_global_resource_waiters WHERE expires_at>?").get(timestamp) as { count: number; oldest: string | null };
    const rows = this.db.prepare("SELECT resource,SUM(units) AS units FROM miki_global_resource_leases WHERE lease_expires_at>? GROUP BY resource ORDER BY resource").all(timestamp) as Array<{ resource: string; units: number }>;
    return {
      activeLeases: leases.count,
      waiting: waiting.count,
      oldestWaiterAgeMs: waiting.oldest ? Math.max(0, Date.parse(timestamp) - Date.parse(waiting.oldest)) : 0,
      byResource: rows.map((row) => ({ resource: row.resource, units: row.units, capacity: this.capacityFor(row.resource) })),
    };
  }

  private tryAcquire(waiterId: string, leaseId: string, ownerId: string, demands: ResourceDemand[], leaseMs: number): boolean {
    const timestamp = this.now();
    const expires = new Date(Date.parse(timestamp) + leaseMs).toISOString();
    const tx = this.db.transaction(() => {
      this.syncLegacyInteractiveLeases(timestamp);
      this.db.prepare("DELETE FROM miki_global_resource_leases WHERE lease_expires_at<=?").run(timestamp);
      this.db.prepare("DELETE FROM miki_global_resource_waiters WHERE expires_at<=?").run(timestamp);
      const waiter = this.db.prepare("SELECT rowid AS sequence,* FROM miki_global_resource_waiters WHERE waiter_id=? AND expires_at>?").get(waiterId, timestamp) as WaiterRow | undefined;
      if (!waiter) return false;
      // Ageing prevents a steady stream of newly-arriving high-priority work
      // from starving a waiter that has been queued for a long time.
      const effectivePriority = (priority: number, requestedAt: string) =>
        priority + Math.max(0, Math.floor((Date.parse(timestamp) - Date.parse(requestedAt)) / 600_000));
      const myPriority = effectivePriority(waiter.priority, waiter.requested_at);
      const candidates = this.db.prepare(`SELECT rowid AS sequence,waiter_id,resources_json,priority,requested_at
        FROM miki_global_resource_waiters WHERE expires_at>? AND rowid<>?`)
        .all(timestamp, waiter.sequence) as Array<{ sequence: number; waiter_id: string; resources_json: string; priority: number; requested_at: string }>;
      const earlier = candidates.filter((candidate) => {
        const candidatePriority = effectivePriority(candidate.priority, candidate.requested_at);
        return candidatePriority > myPriority || (candidatePriority === myPriority
          && (candidate.requested_at < waiter.requested_at
            || (candidate.requested_at === waiter.requested_at && candidate.sequence < waiter.sequence)));
      }).sort((a, b) => effectivePriority(b.priority, b.requested_at) - effectivePriority(a.priority, a.requested_at)
        || a.requested_at.localeCompare(b.requested_at) || a.sequence - b.sequence);
      const mine = new Set(demands.map((demand) => demand.resource));
      for (const candidate of earlier) {
        let candidateResources: unknown;
        try { candidateResources = JSON.parse(candidate.resources_json); } catch { continue; }
        if (Array.isArray(candidateResources) && candidateResources.some((entry) => entry && typeof entry === "object" && mine.has(String((entry as ResourceDemand).resource)))) return false;
      }
      for (const demand of demands) {
        const used = Number((this.db.prepare("SELECT COALESCE(SUM(units),0) AS units FROM miki_global_resource_leases WHERE resource=? AND lease_expires_at>?").get(demand.resource, timestamp) as { units: number }).units);
        if (used + demand.units > this.capacityFor(demand.resource)) return false;
      }
      const insert = this.db.prepare(`INSERT INTO miki_global_resource_leases(lease_id,owner_id,resource,units,lease_expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)`);
      for (const demand of demands) insert.run(leaseId, ownerId, demand.resource, demand.units, expires, timestamp, timestamp);
      this.db.prepare("DELETE FROM miki_global_resource_waiters WHERE waiter_id=?").run(waiterId);
      return true;
    });
    return Boolean(tx.immediate());
  }

  private capacityFor(resource: string): number {
    const persisted = this.db.prepare("SELECT capacity FROM miki_global_resource_capacities WHERE resource=?").get(resource) as { capacity: number } | undefined;
    if (persisted && Number.isFinite(persisted.capacity)) return clampInt(persisted.capacity, 1, 10_000);
    const configured = this.capacities[resource];
    return Number.isFinite(configured) ? clampInt(configured, 1, 10_000) : 1;
  }

  private migrateLegacyInteractiveLease(): void {
    this.syncLegacyInteractiveLeases(this.now());
  }

  /**
   * During rolling upgrades an older gateway may still renew its legacy lease.
   * Mirror it on every admission transaction until no old lease remains, rather
   * than relying on a one-time startup copy that could expire while the old
   * process is still active.
   */
  private syncLegacyInteractiveLeases(timestamp: string): void {
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='miki_interactive_resource_leases'").get();
    if (!exists) {
      this.db.prepare("DELETE FROM miki_global_resource_leases WHERE lease_id LIKE 'legacy:%'").run();
      return;
    }
    const legacyRows = this.db.prepare(`SELECT owner_id,lease_expires_at,updated_at
      FROM miki_interactive_resource_leases WHERE resource='shared_interactive' AND lease_expires_at>?`).all(timestamp) as Array<{ owner_id: string; lease_expires_at: string; updated_at: string }>;
    const activeIds = new Set<string>();
    const upsert = this.db.prepare(`INSERT INTO miki_global_resource_leases
      (lease_id,owner_id,resource,units,lease_expires_at,created_at,updated_at)
      VALUES(?,?,'shared_interactive',1,?,?,?)
      ON CONFLICT(lease_id,resource) DO UPDATE SET
        lease_expires_at=excluded.lease_expires_at, updated_at=excluded.updated_at`);
    for (const legacy of legacyRows) {
      const leaseId = `legacy:${legacy.owner_id}`;
      activeIds.add(leaseId);
      upsert.run(leaseId, legacy.owner_id, legacy.lease_expires_at, legacy.updated_at, legacy.updated_at);
    }
    const stale = this.db.prepare("SELECT DISTINCT lease_id FROM miki_global_resource_leases WHERE lease_id LIKE 'legacy:%'").all() as Array<{ lease_id: string }>;
    for (const entry of stale) {
      if (!activeIds.has(entry.lease_id)) this.db.prepare("DELETE FROM miki_global_resource_leases WHERE lease_id=?").run(entry.lease_id);
    }
  }

}

function normalizeDemands(input: ResourceDemand[]): ResourceDemand[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("At least one resource must be requested.");
  const merged = new Map<string, number>();
  for (const entry of input) {
    const resource = String(entry?.resource ?? "").trim().slice(0, 100);
    const units = Number(entry?.units ?? 1);
    if (!resource || !Number.isSafeInteger(units) || units < 1) throw new Error("Resource names and positive integer units are required.");
    merged.set(resource, (merged.get(resource) ?? 0) + units);
  }
  return [...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([resource, units]) => ({ resource, units }));
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(Number.isFinite(value) ? value : minimum)));
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(reason ? String(reason) : "Resource acquisition was cancelled.");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal.reason)); return; }
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(abortError(signal?.reason)); };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
