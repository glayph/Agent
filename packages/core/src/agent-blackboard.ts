/**
 * AgentBlackboard — Phase 2: Shared State / Coordination Store
 *
 * A shared key-value store where agents can post results and read each
 * other's context without tight coupling. Supports:
 *  - TTL-based automatic expiry
 *  - Prefix-scoped reads (namespace isolation)
 *  - Optimistic locking to prevent lost-update races
 *  - Mutation audit trail (last N writes)
 *
 * Called by AgentBlackboard.expire() on a heartbeat interval.
 */

import * as crypto from "crypto";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BlackboardEntry {
  key: string;
  value: unknown;
  writtenBy: string;
  version: number;
  writtenAt: Date;
  expiresAt?: Date;
}

export interface BlackboardWriteOptions {
  /** Time-to-live in milliseconds before the entry is automatically expired */
  ttlMs?: number;
  /**
   * Optimistic lock version. If provided, the write only succeeds if the
   * current version matches. Pass `0` to guarantee an insert (key must not exist).
   */
  expectedVersion?: number;
}

export class BlackboardConflictError extends Error {
  constructor(
    public readonly key: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `Blackboard conflict on key "${key}": expected version ${expectedVersion}, got ${actualVersion}`,
    );
    this.name = "BlackboardConflictError";
  }
}

// ---------------------------------------------------------------------------
// Audit log entry
// ---------------------------------------------------------------------------

interface AuditEntry {
  id: string;
  key: string;
  agentId: string;
  operation: "write" | "expire" | "delete";
  version: number;
  at: Date;
}

// ---------------------------------------------------------------------------
// AgentBlackboard
// ---------------------------------------------------------------------------

export class AgentBlackboard extends EventEmitter {
  private store: Map<string, BlackboardEntry> = new Map();
  private audit: AuditEntry[] = [];
  private readonly maxAuditSize: number;

  constructor(maxAuditSize: number = 200) {
    super();
    this.maxAuditSize = maxAuditSize;
  }

  // ---- Write ---------------------------------------------------------------

  /**
   * Write a value to the blackboard.
   *
   * @throws BlackboardConflictError if expectedVersion does not match current version.
   */
  write(
    key: string,
    value: unknown,
    agentId: string,
    options: BlackboardWriteOptions = {},
  ): BlackboardEntry {
    const existing = this.store.get(key);

    // Optimistic locking
    if (options.expectedVersion !== undefined) {
      const current = existing?.version ?? 0;
      if (current !== options.expectedVersion) {
        throw new BlackboardConflictError(
          key,
          options.expectedVersion,
          current,
        );
      }
    }

    const version = (existing?.version ?? 0) + 1;
    const writtenAt = new Date();
    const expiresAt = options.ttlMs
      ? new Date(writtenAt.getTime() + options.ttlMs)
      : undefined;

    const entry: BlackboardEntry = {
      key,
      value,
      writtenBy: agentId,
      version,
      writtenAt,
      expiresAt,
    };

    this.store.set(key, entry);
    this._appendAudit({ key, agentId, operation: "write", version });
    this.emit("write", entry);
    return entry;
  }

  // ---- Read ----------------------------------------------------------------

  /**
   * Read a single key. Returns null if the key does not exist or has expired.
   */
  read(key: string): unknown | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < new Date()) {
      this._expire(key);
      return null;
    }
    return entry.value;
  }

  /**
   * Read the full entry (including metadata) for a key.
   */
  readEntry(key: string): BlackboardEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < new Date()) {
      this._expire(key);
      return null;
    }
    return entry;
  }

  /**
   * Read all keys sharing the given prefix. Returns a flat record.
   */
  readAll(prefix: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const now = new Date();
    const toExpire: string[] = [];

    for (const [key, entry] of this.store) {
      if (!key.startsWith(prefix)) continue;
      if (entry.expiresAt && entry.expiresAt < now) {
        toExpire.push(key);
        continue;
      }
      result[key] = entry.value;
    }

    for (const key of toExpire) {
      this._expire(key);
    }

    return result;
  }

  /**
   * Delete a specific key, regardless of expiry.
   */
  delete(key: string, agentId: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    this.store.delete(key);
    this._appendAudit({
      key,
      agentId,
      operation: "delete",
      version: entry.version,
    });
    this.emit("delete", key, agentId);
    return true;
  }

  // ---- Expiry (called by heartbeat) ----------------------------------------

  /**
   * Scan and evict all entries whose TTL has elapsed.
   * Should be called periodically (e.g. every 30 s) by the heartbeat engine.
   */
  expire(): number {
    const now = new Date();
    let count = 0;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt && entry.expiresAt < now) {
        this._expire(key);
        count++;
      }
    }
    return count;
  }

  // ---- Introspection -------------------------------------------------------

  keys(): string[] {
    return Array.from(this.store.keys());
  }

  size(): number {
    return this.store.size;
  }

  recentAudit(limit: number = 20): AuditEntry[] {
    return this.audit.slice(-limit);
  }

  clear(): void {
    this.store.clear();
    this.emit("clear");
  }

  // ---- Private helpers -----------------------------------------------------

  private _expire(key: string): void {
    const entry = this.store.get(key);
    if (!entry) return;
    this.store.delete(key);
    this._appendAudit({
      key,
      agentId: "system",
      operation: "expire",
      version: entry.version,
    });
    this.emit("expire", key);
  }

  private _appendAudit(partial: Omit<AuditEntry, "id" | "at">): void {
    if (this.audit.length >= this.maxAuditSize) {
      this.audit.shift();
    }
    this.audit.push({ id: crypto.randomUUID(), at: new Date(), ...partial });
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const globalAgentBlackboard = new AgentBlackboard();
