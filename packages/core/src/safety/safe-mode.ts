import * as fs from "fs";
import * as path from "path";
import { type RuntimePaths } from "../paths.js";

export type SafeModeSeverity = "info" | "warning" | "critical";

export interface SafeModeReason {
  module: string;
  reason: string;
  severity: SafeModeSeverity;
  recommendation: string;
  createdAt: string;
}

export interface SafeModeState {
  enabled: boolean;
  reasons: SafeModeReason[];
  updatedAt: string;
}

function emptySafeModeState(): SafeModeState {
  return {
    enabled: false,
    reasons: [],
    updatedAt: new Date().toISOString(),
  };
}

function isSeverity(value: unknown): value is SafeModeSeverity {
  return value === "info" || value === "warning" || value === "critical";
}

function sanitizeReason(value: unknown): SafeModeReason | null {
  if (!value || typeof value !== "object") return null;
  const reason = value as Partial<SafeModeReason>;
  if (
    typeof reason.module !== "string" ||
    !reason.module.trim() ||
    typeof reason.reason !== "string" ||
    !reason.reason.trim() ||
    !isSeverity(reason.severity) ||
    typeof reason.recommendation !== "string" ||
    !reason.recommendation.trim() ||
    typeof reason.createdAt !== "string" ||
    Number.isNaN(Date.parse(reason.createdAt))
  ) {
    return null;
  }
  return {
    module: reason.module.trim().slice(0, 160),
    reason: reason.reason.trim().slice(0, 1000),
    severity: reason.severity,
    recommendation: reason.recommendation.trim().slice(0, 1000),
    createdAt: reason.createdAt,
  };
}

function sanitizeState(value: unknown): SafeModeState {
  if (!value || typeof value !== "object") return emptySafeModeState();
  const parsed = value as Partial<SafeModeState>;
  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.map(sanitizeReason).filter((item) => item !== null)
    : [];
  const updatedAt =
    typeof parsed.updatedAt === "string" &&
    !Number.isNaN(Date.parse(parsed.updatedAt))
      ? parsed.updatedAt
      : new Date().toISOString();
  return {
    enabled: reasons.length > 0 && parsed.enabled !== false,
    reasons: reasons.slice(0, 100),
    updatedAt,
  };
}

export class SafeModeManager {
  constructor(private readonly statePath: string) {}

  getState(): SafeModeState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf-8"));
      return sanitizeState(parsed);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return emptySafeModeState();
      }
      throw err;
    }
  }

  enter(reason: Omit<SafeModeReason, "createdAt">): SafeModeState {
    const state = this.getState();
    const createdAt = new Date().toISOString();
    const nextReason = sanitizeReason({ ...reason, createdAt });
    if (!nextReason) {
      throw new Error("Safe mode reason is invalid.");
    }
    const reasons = [
      nextReason,
      ...state.reasons.filter(
        (item) =>
          item.module !== reason.module || item.reason !== reason.reason,
      ),
    ].slice(0, 100);
    const next: SafeModeState = {
      enabled: true,
      reasons,
      updatedAt: createdAt,
    };
    this.save(next);
    return next;
  }

  clear(moduleName?: string): SafeModeState {
    const state = this.getState();
    const reasons = moduleName
      ? state.reasons.filter((item) => item.module !== moduleName)
      : [];
    const next: SafeModeState = {
      enabled: reasons.length > 0,
      reasons,
      updatedAt: new Date().toISOString(),
    };
    this.save(next);
    return next;
  }

  private save(state: SafeModeState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmpPath = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, this.statePath);
  }
}

export function createSafeModeManager(paths: RuntimePaths): SafeModeManager {
  return new SafeModeManager(path.join(paths.dataDir, "safe-mode.json"));
}
