/**
 * Core memory bridge — fully local (TKG + file memory).
 *
 * Durable semantic memory is the local Temporal Knowledge Graph + graph
 * cognitive layer in @miki/memory. File notes / compaction live in
 * packages/core/src/memory-files (FileMemoryService) and are separate.
 */
import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";
import type {
  AgentMemoryIntegration,
  MikiMemoryModule,
  TemporalKnowledgeGraph,
} from "./types.js";

const require = createRequire(import.meta.url);

let _integration: AgentMemoryIntegration | null = null;
let _tkg: TemporalKnowledgeGraph | null = null;
let _dataDir: string | null = null;

function tkgDbPath(dataDir: string): string {
  return path.join(dataDir, "memory", "tkg.db");
}

export function initMemory(dataDir: string): AgentMemoryIntegration {
  if (_integration && _dataDir === dataDir) return _integration;
  closeMemory();

  const memoryModule = require("@miki/memory") as MikiMemoryModule;
  if (typeof memoryModule.TemporalKnowledgeGraph !== "function") {
    throw new Error("@miki/memory does not provide TemporalKnowledgeGraph");
  }
  if (typeof memoryModule.AgentMemoryIntegration !== "function") {
    throw new Error("@miki/memory does not provide AgentMemoryIntegration");
  }

  const dbPath = tkgDbPath(dataDir);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const tkg = new memoryModule.TemporalKnowledgeGraph(dbPath, {
    scope: {
      agentId: process.env.MIKI_AGENT_ID || "miki",
      ownerId: process.env.MIKI_OWNER_ID || "default-owner",
      workspaceId: process.env.MIKI_WORKSPACE_ID || "default-workspace",
    },
  });
  if (typeof (tkg as { initializeSync?: () => unknown }).initializeSync === "function") {
    (tkg as { initializeSync: () => unknown }).initializeSync();
  }

  _tkg = tkg as TemporalKnowledgeGraph;
  _integration = new memoryModule.AgentMemoryIntegration(tkg, {
    scope: {
      agentId: process.env.MIKI_AGENT_ID || "miki",
      ownerId: process.env.MIKI_OWNER_ID || "default-owner",
      workspaceId: process.env.MIKI_WORKSPACE_ID || "default-workspace",
    },
  }) as AgentMemoryIntegration;
  _dataDir = dataDir;
  console.log(`[MemoryBridge] Local TKG memory initialized → ${dbPath}`);
  return _integration;
}

export function getMemory(): AgentMemoryIntegration | null {
  return _integration;
}

export function getTKG(): TemporalKnowledgeGraph | null {
  return _tkg;
}

export async function backupMemory(destinationPath: string): Promise<void> {
  if (!_dataDir) throw new Error("local TKG memory is not initialized");
  const source = tkgDbPath(_dataDir);
  if (!fs.existsSync(source)) throw new Error("local TKG database not found");
  await fs.promises.rm(destinationPath, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  // Copy db + WAL siblings if present
  const dir = path.dirname(source);
  const base = path.basename(source);
  await fs.promises.mkdir(destinationPath, { recursive: true });
  for (const name of await fs.promises.readdir(dir)) {
    if (name === base || name.startsWith(base)) {
      await fs.promises.copyFile(path.join(dir, name), path.join(destinationPath, name));
    }
  }
}

export function restoreMemory(
  backupPath: string,
  dataDir: string,
): AgentMemoryIntegration {
  if (!fs.existsSync(backupPath)) throw new Error(`local TKG backup not found: ${backupPath}`);
  closeMemory();
  const targetDir = path.dirname(tkgDbPath(dataDir));
  fs.mkdirSync(targetDir, { recursive: true });
  const stat = fs.statSync(backupPath);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(backupPath)) {
      fs.copyFileSync(path.join(backupPath, name), path.join(targetDir, name));
    }
  } else {
    fs.copyFileSync(backupPath, tkgDbPath(dataDir));
  }
  return initMemory(dataDir);
}

export function multiHopRetrieve(opts: Record<string, unknown> = {}): unknown {
  const tkg = _tkg;
  if (!tkg) {
    return { provider: "local-tkg", hops: [], nodes: [], edges: [], analysis: "TKG not initialized." };
  }
  try {
    const memoryModule = require("@miki/memory") as MikiMemoryModule & {
      MultiHopRetriever?: new (tkg: unknown) => { retrieve: (o: Record<string, unknown>) => unknown };
    };
    if (typeof memoryModule.MultiHopRetriever === "function") {
      const retriever = new memoryModule.MultiHopRetriever(tkg);
      const result = retriever.retrieve(opts) as Record<string, unknown>;
      return { provider: "local-tkg", ...result };
    }
  } catch {
    // fall through
  }
  return { provider: "local-tkg", hops: [], nodes: [], edges: [], analysis: "Multi-hop unavailable." };
}

export function getSelectiveContext(
  query = "",
  options: Record<string, unknown> = {},
): unknown {
  const tkg = _tkg as TemporalKnowledgeGraph & {
    getSelectiveContext?: (q: string, o: Record<string, unknown>) => unknown;
  } | null;
  if (!tkg?.getSelectiveContext) {
    return {
      provider: "local-tkg",
      items: [],
      text: "",
      trace: { provider: "local-tkg" },
      stats: { candidateCount: 0, selectedCount: 0, provider: "local-tkg" },
    };
  }
  return tkg.getSelectiveContext(query, options);
}

export function getSelectiveMemoryStats(scope?: Record<string, string>): unknown {
  const tkg = _tkg as TemporalKnowledgeGraph & {
    selectiveMemory?: { getStats?: (s?: Record<string, string>) => unknown };
  } | null;
  if (tkg?.selectiveMemory?.getStats) {
    return { provider: "local-tkg", primary: true, localPersistence: true, ...((tkg.selectiveMemory.getStats(scope) as object) || {}) };
  }
  return { provider: "local-tkg", primary: true, localPersistence: true };
}

export function listSelectiveMemory(
  scope?: Record<string, string>,
  options: Record<string, unknown> = {},
): unknown[] {
  const tkg = _tkg as TemporalKnowledgeGraph & {
    selectiveMemory?: { list?: (s?: Record<string, string>, o?: Record<string, unknown>) => unknown[] };
  } | null;
  return tkg?.selectiveMemory?.list?.(scope, options) ?? [];
}

export function inspectSelectiveMemory(
  scope?: Record<string, string>,
  chunkId?: string,
): unknown {
  const tkg = _tkg as TemporalKnowledgeGraph & {
    selectiveMemory?: { inspect?: (s?: Record<string, string>, id?: string) => unknown };
  } | null;
  return tkg?.selectiveMemory?.inspect?.(scope, chunkId) ?? null;
}

export function forgetSelectiveMemory(scope: Record<string, string>, chunkId: string): unknown {
  const tkg = _tkg as TemporalKnowledgeGraph & {
    selectiveMemory?: { forget?: (s: Record<string, string>, id: string) => unknown };
  } | null;
  if (tkg?.selectiveMemory?.forget) {
    return tkg.selectiveMemory.forget(scope, chunkId);
  }
  return { provider: "local-tkg", forgotten: false, chunkId, message: "Selective forget unavailable." };
}

export function reindexSelectiveMemory(scope?: Record<string, string>): unknown {
  const tkg = _tkg as TemporalKnowledgeGraph & {
    selectiveMemory?: { reindex?: (s?: Record<string, string>) => unknown };
  } | null;
  if (tkg?.selectiveMemory?.reindex) {
    return tkg.selectiveMemory.reindex(scope);
  }
  return { provider: "local-tkg", reindexed: 0 };
}

export function getNodeGraphContext(query = "", limit = 8): unknown[] {
  const tkg = _tkg as TemporalKnowledgeGraph & {
    getNodeGraphContext?: (q: string, n: number) => unknown[];
  } | null;
  return tkg?.getNodeGraphContext?.(query, limit) ?? [];
}

export function getNodeGraphSnapshot(limit = 100): unknown {
  const tkg = _tkg as TemporalKnowledgeGraph & {
    getNodeGraphSnapshot?: (n: number) => unknown;
  } | null;
  return tkg?.getNodeGraphSnapshot?.(limit) ?? { provider: "local-tkg", nodes: [], edges: [] };
}

export function getTemporaryMemory(): unknown | null {
  const tkg = _tkg as TemporalKnowledgeGraph & {
    getTemporaryMemory?: () => unknown;
  } | null;
  return tkg?.getTemporaryMemory?.() ?? null;
}

export function closeMemory(): void {
  try {
    _tkg?.close?.();
  } catch {
    // Shutdown must remain best-effort.
  }
  try {
    (_integration as AgentMemoryIntegration & { tkg?: { close?: () => void } } | null)?.tkg?.close?.();
  } catch {
    // ignore
  }
  _integration = null;
  _tkg = null;
  _dataDir = null;
}
