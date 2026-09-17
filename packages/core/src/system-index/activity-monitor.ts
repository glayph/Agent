/**
 * Lite activity monitor — tracks recent user/agent filesystem focus paths
 * for dynamic system indexing hints and prompt context.
 * Intentionally small, in-memory + optional SQLite via SystemIndexer roots.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ActivityEvent {
  at: string;
  kind: "path_focus" | "tool" | "user_message" | "project";
  path?: string;
  tool?: string;
  detail?: string;
}

const MAX_EVENTS = 200;

export class ActivityMonitor {
  private events: ActivityEvent[] = [];
  private focusPaths = new Map<string, number>();

  record(event: Omit<ActivityEvent, "at"> & { at?: string }): void {
    const full: ActivityEvent = {
      at: event.at || new Date().toISOString(),
      kind: event.kind,
      path: event.path,
      tool: event.tool,
      detail: event.detail,
    };
    this.events.push(full);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    if (full.path) {
      const resolved = path.resolve(full.path);
      this.focusPaths.set(resolved, Date.now());
      // keep map bounded
      if (this.focusPaths.size > 100) {
        const sorted = [...this.focusPaths.entries()].sort(
          (a, b) => a[1] - b[1],
        );
        for (const [k] of sorted.slice(0, this.focusPaths.size - 80)) {
          this.focusPaths.delete(k);
        }
      }
    }
  }

  recordTool(tool: string, args: Record<string, unknown>): void {
    const pathKeys = ["path", "src", "dest", "archive", "working_dir"];
    let p: string | undefined;
    for (const k of pathKeys) {
      const v = args[k];
      if (typeof v === "string" && v.trim()) {
        p = v;
        break;
      }
    }
    this.record({
      kind: "tool",
      tool,
      path: p,
      detail: Object.keys(args).slice(0, 6).join(","),
    });
  }

  recent(limit = 20): ActivityEvent[] {
    return this.events.slice(-limit);
  }

  topFocusPaths(limit = 10): string[] {
    return [...this.focusPaths.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([p]) => p)
      .filter((p) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      });
  }

  promptBlock(limit = 8): string {
    const focus = this.topFocusPaths(limit);
    if (focus.length === 0) return "";
    return (
      "\n[RECENT ACTIVITY / FOCUS PATHS]\n" +
      focus.map((p) => `- ${p}`).join("\n") +
      "\n"
    );
  }
}

let singleton: ActivityMonitor | null = null;

export function getActivityMonitor(): ActivityMonitor {
  if (!singleton) singleton = new ActivityMonitor();
  return singleton;
}

export function defaultIndexRoots(): string[] {
  const home = os.homedir();
  const privateRoot =
    process.env.MIKI_PRIVATE_DIR ||
    path.join(home, ".local", "share", "Miki", "private");
  const roots = [home, privateRoot];
  if (process.env.MIKI_WORKSPACE_DIR) {
    roots.push(process.env.MIKI_WORKSPACE_DIR);
  }
  return roots;
}
