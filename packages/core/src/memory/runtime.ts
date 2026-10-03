/**
 * Core memory bridge.
 *
 * Miki's only durable memory provider is the local Mem0 OSS implementation
 * living in @miki/memory. No hosted Mem0 client, provider switch, SQLite/TKG
 * agent-memory database, or consolidation daemon is initialized here.
 */
import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";
import { resolveConfiguredSecret } from "@miki/config";
import type {
  AgentMemoryIntegration,
  MikiMemoryModule,
  TemporalKnowledgeGraph,
} from "./types.js";

const require = createRequire(import.meta.url);

let _integration: AgentMemoryIntegration | null = null;
let _dataDir: string | null = null;

type Mem0MemoryModule = MikiMemoryModule & {
  Mem0OnlyIntegration?: new (options?: Record<string, unknown>) => AgentMemoryIntegration;
};

export function initMemory(dataDir: string): AgentMemoryIntegration {
  if (_integration && _dataDir === dataDir) return _integration;
  closeMemory();

  const memoryModule = require("@miki/memory") as Mem0MemoryModule;
  if (typeof memoryModule.Mem0OnlyIntegration !== "function") {
    throw new Error("@miki/memory does not provide the local Mem0 memory core");
  }

  _integration = new memoryModule.Mem0OnlyIntegration({
    dataDir,
    geminiApiKey: resolveConfiguredSecret("GEMINI_API_KEY"),
  });
  _dataDir = dataDir;
  console.log(`[MemoryBridge] Local Mem0 main memory initialized → ${path.join(dataDir, "memory")}`);
  return _integration;
}

export function getMemory(): AgentMemoryIntegration | null {
  return _integration;
}

/** Local Mem0 owns its own vector/history SQLite files; TKG is intentionally absent. */
export function getTKG(): TemporalKnowledgeGraph | null {
  return null;
}

export async function backupMemory(destinationPath: string): Promise<void> {
  if (!_dataDir) throw new Error("local Mem0 memory is not initialized");
  const source = path.join(_dataDir, "memory");
  if (!fs.existsSync(source)) throw new Error("local Mem0 memory directory not found");
  await fs.promises.rm(destinationPath, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.promises.cp(source, destinationPath, { recursive: true });
}

export function restoreMemory(
  backupPath: string,
  dataDir: string,
): AgentMemoryIntegration {
  if (!fs.existsSync(backupPath)) throw new Error(`local Mem0 backup not found: ${backupPath}`);
  const target = path.join(dataDir, "memory");
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.cpSync(backupPath, target, { recursive: true });
  return initMemory(dataDir);
}

export function multiHopRetrieve(_opts: Record<string, unknown> = {}): unknown {
  return { provider: "mem0-oss-local", hops: [], nodes: [], edges: [], analysis: "Mem0 semantic retrieval is the primary memory path." };
}

export function getSelectiveContext(
  _query = "",
  _options: Record<string, unknown> = {},
): unknown {
  return {
    provider: "mem0-oss-local",
    items: [],
    text: "",
    trace: { provider: "mem0-oss-local" },
    stats: { candidateCount: 0, selectedCount: 0, provider: "mem0-oss-local" },
  };
}

export function getSelectiveMemoryStats(_scope?: Record<string, string>): unknown {
  return { provider: "mem0-oss-local", primary: true, localPersistence: true };
}

export function listSelectiveMemory(
  _scope?: Record<string, string>,
  _options: Record<string, unknown> = {},
): unknown[] {
  return [];
}

export function inspectSelectiveMemory(
  _scope?: Record<string, string>,
  _chunkId?: string,
): unknown {
  return null;
}

export function forgetSelectiveMemory(_scope: Record<string, string>, chunkId: string): unknown {
  return { provider: "mem0-oss-local", forgotten: false, chunkId, message: "Use the Mem0 memory administration API for memory deletion." };
}

export function reindexSelectiveMemory(_scope?: Record<string, string>): unknown {
  return { provider: "mem0-oss-local", reindexed: 0 };
}

export function getNodeGraphContext(_query = "", _limit = 8): unknown[] {
  return [];
}

export function getNodeGraphSnapshot(_limit = 100): unknown {
  return { provider: "mem0-oss-local", nodes: [], edges: [] };
}

export function getTemporaryMemory(): unknown | null {
  return null;
}

export function closeMemory(): void {
  try {
    (_integration as AgentMemoryIntegration & { tkg?: { close?: () => void } } | null)?.tkg?.close?.();
  } catch {
    // Shutdown must remain best-effort.
  }
  _integration = null;
  _dataDir = null;
}
