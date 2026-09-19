import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initMemory, backupMemory, restoreMemory } from "../packages/core/dist/memory/runtime.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "miki-memory-smoke-"));
const dataDir = path.join(root, "data");
const backupPath = path.join(root, "backup.db");
initMemory(dataDir);
await backupMemory(backupPath);
if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) throw new Error("backup was not created");
restoreMemory(backupPath, path.join(root, "restored"));
if (!fs.existsSync(path.join(root, "restored", "agent-memory.db"))) throw new Error("restore was not created");
console.log("memory_backup_restore_ok");
