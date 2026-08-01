/**
 * StructuredLogger: Enhanced logging with rich context
 * - Attach context to every log entry
 * - Structured JSON output
 * - Log sampling for high-volume logs
 * - Configurable log levels per module
 */

import { redactSecrets } from "@hiro/config";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  sessionId?: string;
  userId?: string;
  taskId?: string;
  toolName?: string;
  duration?: number;
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: LogContext;
  extra?: unknown;
  stackTrace?: string;
}

export class StructuredLogger {
  private context: LogContext = {};
  private logBuffer: LogEntry[] = [];
  private moduleLevels: Map<string, LogLevel> = new Map();
  private sampleRates: Map<LogLevel, number> = new Map([
    ["debug", 0.1],
    ["info", 0.5],
    ["warn", 1],
    ["error", 1],
  ]);

  constructor(
    private moduleName: string = "Agent",
    private isDev: boolean = false,
  ) {}

  /**
   * Set context for all subsequent logs
   */
  setContext(context: LogContext): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * Clear context
   */
  clearContext(): void {
    this.context = {};
  }

  /**
   * Log at info level
   */
  info(message: string, extra?: unknown): void {
    this.log("info", message, extra);
  }

  /**
   * Log at warn level
   */
  warn(message: string, extra?: unknown): void {
    this.log("warn", message, extra);
  }

  /**
   * Log at error level
   */
  error(message: string, error?: Error | unknown, extra?: unknown): void {
    const stackTrace = error instanceof Error ? error.stack : undefined;
    // Ensure extra is an object for spreading
    const safeExtra =
      extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {};

    this.log("error", message, { error, ...safeExtra }, stackTrace);
  }

  /**
   * Log at debug level
   */
  debug(message: string, extra?: unknown): void {
    this.log("debug", message, extra);
  }

  /**
   * Core logging method
   */
  private log(
    level: LogLevel,
    message: string,
    extra?: unknown,
    stackTrace?: string,
  ): void {
    // Check if should log based on sampling and module level
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: redactSecrets(this.context),
      extra: redactSecrets(extra),
      stackTrace: stackTrace ? redactSecrets(stackTrace) : undefined,
    };

    this.logBuffer.push(entry);

    // Output to console
    this.output(entry);

    // Flush buffer if too large
    if (this.logBuffer.length > 1000) {
      this.flush();
    }
  }

  /**
   * Determine if should log
   */
  private shouldLog(level: LogLevel): boolean {
    // Check module-level threshold
    const moduleLevel = this.moduleLevels.get(this.moduleName);
    if (
      moduleLevel &&
      this.levelPriority(level) < this.levelPriority(moduleLevel)
    ) {
      return false;
    }

    // Check sampling rate
    if (!this.isDev) {
      const sampleRate = this.sampleRates.get(level) || 1;
      if (Math.random() > sampleRate) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get log level priority (0 = highest)
   */
  private levelPriority(level: LogLevel): number {
    const priorities: Record<LogLevel, number> = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
    };
    return priorities[level] ?? 999;
  }

  /**
   * Output log entry
   */
  private output(entry: LogEntry): void {
    const output = JSON.stringify(entry);

    // Console output with color coding
    const colors: Record<LogLevel, string> = {
      error: "\x1b[31m", // Red
      warn: "\x1b[33m", // Yellow
      info: "\x1b[36m", // Cyan
      debug: "\x1b[35m", // Magenta
    };

    const reset = "\x1b[0m";

    if (entry.level === "error") {
      console.error(`${colors[entry.level]}${output}${reset}`);
    } else if (entry.level === "warn") {
      console.warn(`${colors[entry.level]}${output}${reset}`);
    } else {
      console.log(`${colors[entry.level]}${output}${reset}`);
    }
  }

  /**
   * Set module log level
   */
  setModuleLevel(module: string, level: LogLevel): void {
    this.moduleLevels.set(module, level);
  }

  /**
   * Set sampling rate
   */
  setSampleRate(level: LogLevel, rate: number): void {
    this.sampleRates.set(level, Math.max(0, Math.min(1, rate)));
  }

  /**
   * Flush log buffer
   */
  flush(): LogEntry[] {
    const buffer = this.logBuffer;
    this.logBuffer = [];
    return buffer;
  }

  /**
   * Get buffered logs
   */
  getBuffer(): LogEntry[] {
    return [...this.logBuffer];
  }

  /**
   * Create child logger with additional context
   */
  child(name: string, context: LogContext): StructuredLogger {
    const child = new StructuredLogger(name, this.isDev);
    child.setContext({ ...this.context, ...context });
    return child;
  }
}

// Global logger instance
export const globalLogger = new StructuredLogger("Hiro", false);
