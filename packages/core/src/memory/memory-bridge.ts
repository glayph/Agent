/**
 * memory-bridge.ts
 *
 * Bridges the CommonJS `graphrag-memory` package into the ESM TypeScript
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
  GraphragMemoryModule,
} from "./types.js";

const require = createRequire(import.meta.url);

let _integration: AgentMemoryIntegration | null = null;
let _tkg: TemporalKnowledgeGraph | null = null;
let _dbPath: string | null = null;

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

  const graphragMemory = require("graphrag-memory") as GraphragMemoryModule;
  const { TemporalKnowledgeGraph, AgentMemoryIntegration } = graphragMemory;

  const tkg = new TemporalKnowledgeGraph(dbPath);
  // initialize() is async but sets up the SQLite schema synchronously via
  // better-sqlite3. We fire-and-forget the promise; any schema errors will
  // surface on the first DB write.
  tkg.initialize().catch((err: Error) => {
    console.error("[MemoryBridge] TKG initialization error:", err.message);
  });

  _tkg = tkg;
  _dbPath = dbPath;
  _integration = new AgentMemoryIntegration(tkg);

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
 * Close the underlying SQLite connection. Called on graceful shutdown.
 */
export function closeMemory(): void {
  if (_tkg) {
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
