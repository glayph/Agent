/**
 * memory-bridge.ts
 *
 * Bridges the CommonJS `@miki/memory` package into the ESM TypeScript
 * @miki/core package. Uses createRequire so that the CJS module is loaded
 * correctly at runtime without needing it to be compiled to ESM first.
 *
 * Exposes a lazily-initialized singleton AgentMemoryIntegration instance
 * that agent.ts uses to read/write memory on every conversation turn
 * (entirely in the backend — nothing from this module is shown in the UI).
 */

import { createRequire } from "module";
import * as path from "path";
import * as fs from "fs";
import type {
  AgentMemoryIntegration,
  TemporalKnowledgeGraph,
  MikiMemoryModule,
  MemoryConsolidationDaemon as MemoryConsolidationDaemonType,
} from "./types.js";

const require = createRequire(import.meta.url);

let _integration: AgentMemoryIntegration | null = null;
let _tkg: TemporalKnowledgeGraph | null = null;
let _dbPath: string | null = null;
let _daemon: MemoryConsolidationDaemonType | null = null;

/**
 * Initialize (or return the already-initialized) AgentMemoryIntegration
 * for the given data directory. Calling this multiple times with the same
 * path is safe and cheap — the singleton is returned immediately after the
 * first call.
 *
 * The DB file is placed at `<dataDir>/agent-memory.db` so it sits alongside
 * other agent runtime data (core_backend.log, etc.).
 *
 * @param dataDir - absolute path to the agent's data directory
 */
export function initMemory(dataDir: string): AgentMemoryIntegration {
  const dbPath = path.join(dataDir, "agent-memory.db");

  if (_integration && _dbPath === dbPath) {
    return _integration;
  }

  // If the data dir doesn't exist yet, create it so SQLite can open the file.
  fs.mkdirSync(dataDir, { recursive: true });

  const mikiMemory = require("@miki/memory") as MikiMemoryModule;
  const {
    TemporalKnowledgeGraph,
    AgentMemoryIntegration,
    MemoryConsolidationDaemon,
  } = mikiMemory;

  const tkg = new TemporalKnowledgeGraph(dbPath);
  // Use initializeSync so schema + FTS tables exist before any caller can
  // write/query. Previously initialize() was fire-and-forget async, which
  // raced the first turn against CREATE TABLE.
  try {
    if (
      typeof (tkg as { initializeSync?: () => unknown }).initializeSync ===
      "function"
    ) {
      (tkg as { initializeSync: () => unknown }).initializeSync();
    } else {
      // Fallback for older package shapes: block on the async path.

      void tkg.initialize();
    }
  } catch (err) {
    console.error(
      "[MemoryBridge] TKG initialization error:",
      err instanceof Error ? err.message : err,
    );
    throw err;
  }

  _tkg = tkg;
  _dbPath = dbPath;
  _integration = new AgentMemoryIntegration(tkg);

  // Daemon starts only after schema is confirmed ready (sync path above).
  try {
    _daemon = new MemoryConsolidationDaemon(tkg);
    _daemon.start();
  } catch (err) {
    console.error(
      "[MemoryBridge] Consolidation daemon start error:",
      err instanceof Error ? err.message : err,
    );
  }

  console.log(`[MemoryBridge] Memory initialized → ${dbPath}`);
  return _integration;
}

/**
 * Return the currently-active AgentMemoryIntegration, or null if
 * initMemory() has not yet been called.
 */
export function getMemory(): AgentMemoryIntegration | null {
  return _integration;
}

/**
 * Return the underlying TemporalKnowledgeGraph instance (or null).
 * Used by higher layers that need multi-hop retrieval or temporary sessions.
 */
export function getTKG(): TemporalKnowledgeGraph | null {
  return _tkg;
}

/**
 * Multi-hop retrieval (call → analysis → call loop).
 * Thin wrapper over TKG.multiHopRetrieve when available.
 */
export function multiHopRetrieve(opts: Record<string, unknown> = {}): unknown {
  if (!_tkg)
    return {
      hops: [],
      nodes: [],
      edges: [],
      analysis: "memory not initialized",
    };
  const fn = (_tkg as { multiHopRetrieve?: (o: unknown) => unknown })
    .multiHopRetrieve;
  if (typeof fn === "function") return fn.call(_tkg, opts);
  return {
    hops: [],
    nodes: [],
    edges: [],
    analysis: "multiHopRetrieve unavailable",
  };
}

/**
 * Temporary memory helper (project-scoped scratch). Returns null if not ready.
 */
export function getSelectiveContext(
  query: string,
  options: Record<string, unknown> = {},
): unknown {
  if (!_tkg) {
    return {
      items: [],
      text: "",
      trace: {},
      stats: {
        candidateCount: 0,
        selectedCount: 0,
        tokensUsed: 0,
        maxTokens: 0,
        latencyMs: 0,
        fallbackReason: "memory_not_initialized",
      },
    };
  }
  const fn = (
    _tkg as {
      getSelectiveContext?: (q: string, o?: Record<string, unknown>) => unknown;
    }
  ).getSelectiveContext;
  return typeof fn === "function"
    ? fn.call(_tkg, query, options)
    : {
        items: [],
        text: "",
        trace: {},
        stats: { fallbackReason: "selective_retrieval_unavailable" },
      };
}

export function getSelectiveMemoryStats(
  scope?: Record<string, string>,
): unknown {
  if (!_tkg)
    return { chunks: 0, edges: 0, postings: 0, retrievals: 0, byRegion: [] };
  const fn = (
    _tkg as {
      getSelectiveMemoryStats?: (s?: Record<string, string>) => unknown;
    }
  ).getSelectiveMemoryStats;
  return typeof fn === "function"
    ? fn.call(_tkg, scope)
    : { chunks: 0, edges: 0, postings: 0, retrievals: 0, byRegion: [] };
}

export function listSelectiveMemory(
  scope?: Record<string, string>,
  options: Record<string, unknown> = {},
): unknown[] {
  if (!_tkg) return [];
  const fn = (
    _tkg as {
      listSelectiveMemory?: (
        s?: Record<string, string>,
        o?: Record<string, unknown>,
      ) => unknown[];
    }
  ).listSelectiveMemory;
  return typeof fn === "function" ? fn.call(_tkg, scope, options) : [];
}

export function inspectSelectiveMemory(
  scope: Record<string, string>,
  chunkId: string,
): unknown {
  if (!_tkg) return null;
  const fn = (
    _tkg as {
      inspectSelectiveMemory?: (
        s: Record<string, string>,
        id: string,
      ) => unknown;
    }
  ).inspectSelectiveMemory;
  return typeof fn === "function" ? fn.call(_tkg, scope, chunkId) : null;
}

export function forgetSelectiveMemory(
  scope: Record<string, string>,
  chunkId: string,
): unknown {
  if (!_tkg) return { forgotten: false, chunkId };
  const fn = (
    _tkg as {
      forgetSelectiveMemory?: (
        s: Record<string, string>,
        id: string,
      ) => unknown;
    }
  ).forgetSelectiveMemory;
  return typeof fn === "function"
    ? fn.call(_tkg, scope, chunkId)
    : { forgotten: false, chunkId };
}

export function reindexSelectiveMemory(
  scope?: Record<string, string>,
): unknown {
  if (!_tkg) return { reindexed: 0 };
  const fn = (
    _tkg as { reindexSelectiveMemory?: (s?: Record<string, string>) => unknown }
  ).reindexSelectiveMemory;
  return typeof fn === "function" ? fn.call(_tkg, scope) : { reindexed: 0 };
}

export function getNodeGraphContext(query: string, limit = 8): unknown[] {
  if (!_tkg) return [];
  const fn = (
    _tkg as { getNodeGraphContext?: (q: string, n?: number) => unknown[] }
  ).getNodeGraphContext;
  return typeof fn === "function" ? fn.call(_tkg, query, limit) : [];
}

export function getNodeGraphSnapshot(limit = 100): unknown {
  if (!_tkg) return { nodes: [], edges: [] };
  const fn = (_tkg as { getNodeGraphSnapshot?: (n?: number) => unknown })
    .getNodeGraphSnapshot;
  return typeof fn === "function"
    ? fn.call(_tkg, limit)
    : { nodes: [], edges: [] };
}

export function getTemporaryMemory(): unknown | null {
  if (!_tkg) return null;
  const fn = (_tkg as { getTemporaryMemory?: () => unknown })
    .getTemporaryMemory;
  if (typeof fn === "function") return fn.call(_tkg);
  return null;
}

/**
 * Close the underlying SQLite connection. Called on graceful shutdown.
 */
export function closeMemory(): void {
  if (_daemon) {
    try {
      _daemon.stop();
    } catch {
      // Ignore stop errors during shutdown.
    }
    _daemon = null;
  }
  if (_tkg) {
    // Best-effort: close any stale temporary sessions before shutting down.
    try {
      const tm = (
        _tkg as {
          getTemporaryMemory?: () => {
            closeStaleSessions?: (ms?: number) => number;
          };
        }
      ).getTemporaryMemory?.();
      tm?.closeStaleSessions?.(60 * 60 * 1000);
    } catch {
      // ignore
    }
    try {
      _tkg.close();
    } catch {
      // Ignore close errors during shutdown.
    }
    _tkg = null;
    _integration = null;
    _dbPath = null;
  }
}
