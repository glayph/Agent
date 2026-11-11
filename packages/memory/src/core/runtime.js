"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.initMemory = initMemory;
exports.getMemory = getMemory;
exports.getTKG = getTKG;
exports.backupMemory = backupMemory;
exports.restoreMemory = restoreMemory;
exports.multiHopRetrieve = multiHopRetrieve;
exports.getSelectiveContext = getSelectiveContext;
exports.getSelectiveMemoryStats = getSelectiveMemoryStats;
exports.listSelectiveMemory = listSelectiveMemory;
exports.inspectSelectiveMemory = inspectSelectiveMemory;
exports.forgetSelectiveMemory = forgetSelectiveMemory;
exports.reindexSelectiveMemory = reindexSelectiveMemory;
exports.getNodeGraphContext = getNodeGraphContext;
exports.getNodeGraphSnapshot = getNodeGraphSnapshot;
exports.getTemporaryMemory = getTemporaryMemory;
exports.closeMemory = closeMemory;
// @ts-nocheck -- Node runtime bridge; declarations are maintained by the package boundary.
/**
 * Core memory bridge — fully local (TKG + file memory).
 *
 * Durable semantic memory is the local Temporal Knowledge Graph + graph
 * cognitive layer in @miki/memory. File notes / compaction are part of the canonical @miki/memory package
 * under packages/memory/src/file-memory (FileMemoryService).
 */
const module_1 = require("module");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const loadModule = (0, module_1.createRequire)(__filename);
let _integration = null;
let _tkg = null;
let _dataDir = null;
function tkgDbPath(dataDir) {
    return path.join(dataDir, "memory", "tkg.db");
}
function initMemory(dataDir) {
    if (_integration && _dataDir === dataDir)
        return _integration;
    closeMemory();
    const memoryModule = loadModule("@miki/memory");
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
    if (typeof tkg.initializeSync === "function") {
        tkg.initializeSync();
    }
    _tkg = tkg;
    _integration = new memoryModule.AgentMemoryIntegration(tkg, {
        scope: {
            agentId: process.env.MIKI_AGENT_ID || "miki",
            ownerId: process.env.MIKI_OWNER_ID || "default-owner",
            workspaceId: process.env.MIKI_WORKSPACE_ID || "default-workspace",
        },
    });
    _dataDir = dataDir;
    console.log(`[MemoryBridge] Local TKG memory initialized → ${dbPath}`);
    return _integration;
}
function getMemory() {
    return _integration;
}
function getTKG() {
    return _tkg;
}
async function backupMemory(destinationPath) {
    if (!_dataDir)
        throw new Error("local TKG memory is not initialized");
    const source = tkgDbPath(_dataDir);
    if (!fs.existsSync(source))
        throw new Error("local TKG database not found");
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
function restoreMemory(backupPath, dataDir) {
    if (!fs.existsSync(backupPath))
        throw new Error(`local TKG backup not found: ${backupPath}`);
    closeMemory();
    const targetDir = path.dirname(tkgDbPath(dataDir));
    fs.mkdirSync(targetDir, { recursive: true });
    const stat = fs.statSync(backupPath);
    if (stat.isDirectory()) {
        for (const name of fs.readdirSync(backupPath)) {
            fs.copyFileSync(path.join(backupPath, name), path.join(targetDir, name));
        }
    }
    else {
        fs.copyFileSync(backupPath, tkgDbPath(dataDir));
    }
    return initMemory(dataDir);
}
function multiHopRetrieve(opts = {}) {
    const tkg = _tkg;
    if (!tkg) {
        return { provider: "local-tkg", hops: [], nodes: [], edges: [], analysis: "TKG not initialized." };
    }
    try {
        const memoryModule = loadModule("@miki/memory");
        if (typeof memoryModule.MultiHopRetriever === "function") {
            const retriever = new memoryModule.MultiHopRetriever(tkg);
            const result = retriever.retrieve(opts);
            return { provider: "local-tkg", ...result };
        }
    }
    catch {
        // fall through
    }
    return { provider: "local-tkg", hops: [], nodes: [], edges: [], analysis: "Multi-hop unavailable." };
}
function getSelectiveContext(query = "", options = {}) {
    const tkg = _tkg;
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
function getSelectiveMemoryStats(scope) {
    const tkg = _tkg;
    if (tkg?.selectiveMemory?.stats) {
        return { provider: "local-tkg", primary: true, localPersistence: true, ...(tkg.selectiveMemory.stats(scope) || {}) };
    }
    return { provider: "local-tkg", primary: true, localPersistence: true };
}
function listSelectiveMemory(scope, options = {}) {
    const tkg = _tkg;
    return tkg?.selectiveMemory?.list?.(scope, options) ?? [];
}
function inspectSelectiveMemory(scope, chunkId) {
    const tkg = _tkg;
    return tkg?.selectiveMemory?.inspect?.(scope, chunkId) ?? null;
}
function forgetSelectiveMemory(scope, chunkId) {
    const tkg = _tkg;
    if (tkg?.selectiveMemory?.forget) {
        return tkg.selectiveMemory.forget(scope, chunkId);
    }
    return { provider: "local-tkg", forgotten: false, chunkId, message: "Selective forget unavailable." };
}
function reindexSelectiveMemory(scope) {
    const tkg = _tkg;
    if (tkg?.selectiveMemory?.reindex) {
        return tkg.selectiveMemory.reindex(scope);
    }
    return { provider: "local-tkg", reindexed: 0 };
}
function getNodeGraphContext(query = "", limit = 8) {
    const tkg = _tkg;
    return tkg?.getNodeGraphContext?.(query, limit) ?? [];
}
function getNodeGraphSnapshot(limit = 100) {
    const tkg = _tkg;
    return tkg?.getNodeGraphSnapshot?.(limit) ?? { provider: "local-tkg", nodes: [], edges: [] };
}
function getTemporaryMemory() {
    const tkg = _tkg;
    return tkg?.getTemporaryMemory?.() ?? null;
}
function closeMemory() {
    // AMI holds the same TKG instance as _tkg; close exactly once.
    try {
        _tkg?.close?.();
    }
    catch {
        // Shutdown must remain best-effort.
    }
    _integration = null;
    _tkg = null;
    _dataDir = null;
}
