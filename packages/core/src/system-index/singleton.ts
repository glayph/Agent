import * as path from "path";
import * as os from "os";
import { SystemIndexer } from "./indexer.js";
import type { RuntimePaths } from "../paths.js";
import { getActivityMonitor } from "./activity-monitor.js";
import { listIndexRoots } from "../workspace-folders/index.js";

let indexer: SystemIndexer | null = null;
let scheduleTimer: NodeJS.Timeout | null = null;
let bootStarted = false;

function defaultRuntimePaths(): RuntimePaths {
  const home = os.homedir();
  const dataDir =
    process.env.MIKI_DATA_DIR || path.join(home, ".local", "share", "Miki");
  const configDir =
    process.env.MIKI_CONFIG_DIR || path.join(home, ".config", "Miki");
  const privateDir =
    process.env.MIKI_PRIVATE_DIR || path.join(dataDir, "private");
  const sourceDir = process.env.MIKI_WORKSPACE_DIR || privateDir;
  return {
    configDir,
    dataDir,
    skillsDir: path.join(dataDir, "skills"),
    cacheDir: path.join(home, ".cache", "Miki"),
    binDir: path.join(dataDir, "bin"),
    docsDir: path.join(dataDir, "docs"),
    outputDir: path.join(dataDir, "output"),
    sourceDir,
  };
}

function privateDirPath(): string {
  const home = os.homedir();
  return (
    process.env.MIKI_PRIVATE_DIR ||
    path.join(home, ".local", "share", "Miki", "private")
  );
}

/** Effective index roots: user Settings folders + Miki private (never whole disk by default). */
export function resolveIndexRoots(runtimePaths?: RuntimePaths): string[] {
  const paths = runtimePaths || defaultRuntimePaths();
  const privateDir = privateDirPath();
  let userRoots: string[] = [];
  try {
    userRoots = listIndexRoots(paths);
  } catch {
    userRoots = [];
  }
  return [...new Set([privateDir, ...userRoots].filter(Boolean))];
}

export function getSystemIndexer(runtimePaths?: RuntimePaths): SystemIndexer {
  if (indexer) return indexer;
  const paths = runtimePaths || defaultRuntimePaths();
  indexer = new SystemIndexer(paths, undefined, { startWatchers: true });
  return indexer;
}

/**
 * Boot system index: only user-configured workspace folders + private space.
 * Full filesystem is NOT indexed unless the user adds folders in Settings.
 */
export function ensureSystemIndexStarted(
  runtimePaths?: RuntimePaths,
): SystemIndexer {
  const paths = runtimePaths || defaultRuntimePaths();
  const ix = getSystemIndexer(paths);
  if (bootStarted) return ix;
  bootStarted = true;

  const privateDir = privateDirPath();
  const roots = resolveIndexRoots(paths);

  try {
    ix.configure({
      roots,
      includeSystemRoots: false,
      indexContent: true,
      realtime: true,
    });
  } catch (err) {
    console.warn(
      "[system-index] configure failed:",
      err instanceof Error ? err.message : err,
    );
  }

  void ix
    .rebuild(
      {
        roots,
        includeSystemRoots: false,
        indexContent: true,
        realtime: true,
      },
      { wait: false },
    )
    .then((status) => {
      console.log(
        `[system-index] background scan started (state=${status.state}, roots=${status.effectiveRoots.length})`,
      );
    })
    .catch((err) => {
      console.warn(
        "[system-index] rebuild failed:",
        err instanceof Error ? err.message : err,
      );
    });

  const intervalMs = Number(
    process.env.MIKI_INDEX_INTERVAL_MS || 30 * 60 * 1000,
  );
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = setInterval(() => {
    try {
      const focus = getActivityMonitor().topFocusPaths(15);
      for (const p of focus) {
        void ix.indexPath(p).catch(() => undefined);
      }
      void ix.indexPath(privateDir).catch(() => undefined);
    } catch {
      /* never crash the process */
    }
  }, intervalMs);
  scheduleTimer.unref?.();

  console.log(
    `[system-index] indexing user workspace folders + private only; schedule every ${Math.round(intervalMs / 60000)}m`,
  );
  return ix;
}

export function resetSystemIndexerForTests(): void {
  if (scheduleTimer) {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
  }
  indexer = null;
  bootStarted = false;
}
