import os from "os";
import { performance } from "perf_hooks";

export interface SystemStats {
  timestamp: number;
  cpu: {
    usage: number; // percentage 0-100
    cores: number;
    loadAverage: number[];
  };
  memory: {
    total: number; // bytes
    used: number; // bytes
    free: number; // bytes
    percentage: number; // 0-100
  };
  disk: {
    total: number; // bytes
    used: number; // bytes
    free: number; // bytes
    percentage: number; // 0-100
  };
  uptime: number; // seconds
  processMemory: {
    rss: number; // bytes
    heapUsed: number; // bytes
    heapTotal: number; // bytes
    external: number; // bytes
  };
}

let lastCpuMeasure = getCpuUsage();
let lastMeasureTime = performance.now();

function getCpuUsage(): NodeJS.CpuUsage {
  return process.cpuUsage();
}

export function getSystemStats(): SystemStats {
  const now = performance.now();
  const timeDiff = (now - lastMeasureTime) / 1000; // convert to seconds
  lastMeasureTime = now;

  const currentCpu = getCpuUsage();
  const userDiff = (currentCpu.user - lastCpuMeasure.user) / 1000; // convert to seconds
  const systemDiff = (currentCpu.system - lastCpuMeasure.system) / 1000;
  lastCpuMeasure = currentCpu;

  const cpuUsagePercent = Math.min(
    100,
    Math.round(((userDiff + systemDiff) / (timeDiff * os.cpus().length)) * 100),
  );

  const memStats = os.totalmem();
  const memFree = os.freemem();
  const memUsed = memStats - memFree;

  const processMemory = process.memoryUsage();

  return {
    timestamp: Date.now(),
    cpu: {
      usage: Math.max(0, cpuUsagePercent),
      cores: os.cpus().length,
      loadAverage: os.loadavg(),
    },
    memory: {
      total: memStats,
      used: memUsed,
      free: memFree,
      percentage: Math.round((memUsed / memStats) * 100),
    },
    disk: {
      total: 0, // Not easily available cross-platform
      used: 0,
      free: 0,
      percentage: 0,
    },
    uptime: os.uptime(),
    processMemory: {
      rss: processMemory.rss,
      heapUsed: processMemory.heapUsed,
      heapTotal: processMemory.heapTotal,
      external: processMemory.external,
    },
  };
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}
