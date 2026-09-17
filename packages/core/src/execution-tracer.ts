/**
 * ExecutionTracer: Trace execution and generate flamegraphs
 * - Record spans with timing
 * - Generate ASCII flamegraph
 * - Identify hot paths
 */

export interface Span {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  children: Span[];
  metadata?: Record<string, unknown>;
}

export class ExecutionTracer {
  private stack: Span[] = [];
  private root: Span | null = null;
  private completed: Span[] = [];

  /**
   * Start a span
   */
  startSpan(name: string, metadata?: Record<string, unknown>): void {
    const span: Span = {
      name,
      startTime: Date.now(),
      children: [],
      metadata,
    };

    if (this.stack.length > 0) {
      this.stack[this.stack.length - 1].children.push(span);
    } else {
      this.root = span;
    }

    this.stack.push(span);
  }

  /**
   * End current span
   */
  endSpan(): Span | null {
    if (this.stack.length === 0) {
      return null;
    }

    const span = this.stack.pop()!;
    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;

    if (this.stack.length === 0) {
      this.completed.push(span);
    }

    return span;
  }

  /**
   * Wrapper for async functions
   */
  async spanAsync<T>(
    name: string,
    fn: () => Promise<T>,
    metadata?: Record<string, unknown>,
  ): Promise<T> {
    this.startSpan(name, metadata);
    try {
      return await fn();
    } finally {
      this.endSpan();
    }
  }

  /**
   * Wrapper for sync functions
   */
  span<T>(name: string, fn: () => T, metadata?: Record<string, unknown>): T {
    this.startSpan(name, metadata);
    try {
      return fn();
    } finally {
      this.endSpan();
    }
  }

  /**
   * Generate ASCII flamegraph
   */
  generateFlameGraph(span?: Span, indent: number = 0): string {
    const target = span || this.root;
    if (!target) return "";

    const lines: string[] = [];
    const prefix = "  ".repeat(indent) + "→ ";
    const duration = target.duration
      ? `${target.duration.toFixed(0)}ms`
      : "...";
    const line = `${prefix}${target.name} (${duration})`;

    lines.push(line);

    for (const child of target.children) {
      lines.push(this.generateFlameGraph(child, indent + 1));
    }

    return lines.filter((l) => l.length > 0).join("\n");
  }

  /**
   * Get hot paths (spans taking most time)
   */
  getHotPaths(
    limit: number = 10,
  ): Array<{ name: string; duration: number; percentage: number }> {
    const paths: Array<{ name: string; duration: number }> = [];

    const traverse = (span: Span) => {
      if (span.duration) {
        paths.push({ name: span.name, duration: span.duration });
      }
      for (const child of span.children) {
        traverse(child);
      }
    };

    if (this.root) {
      traverse(this.root);
    }

    const totalDuration = paths.reduce((sum, p) => sum + p.duration, 0);

    return paths
      .map((p) => ({
        ...p,
        percentage: totalDuration > 0 ? (p.duration / totalDuration) * 100 : 0,
      }))
      .sort((a, b) => b.duration - a.duration)
      .slice(0, limit);
  }

  /**
   * Get critical path (longest chain)
   */
  getCriticalPath(): Array<{ name: string; duration: number }> {
    if (!this.root) return [];

    const paths: Array<Array<{ name: string; duration: number }>> = [];

    const traverse = (
      span: Span,
      path: Array<{ name: string; duration: number }>,
    ) => {
      const newPath = [
        ...path,
        { name: span.name, duration: span.duration || 0 },
      ];

      if (span.children.length === 0) {
        paths.push(newPath);
      }

      for (const child of span.children) {
        traverse(child, newPath);
      }
    };

    traverse(this.root, []);

    // Find path with longest total duration
    let longest: Array<{ name: string; duration: number }> = [];
    let maxDuration = 0;

    for (const path of paths) {
      const duration = path.reduce((sum, s) => sum + s.duration, 0);
      if (duration > maxDuration) {
        maxDuration = duration;
        longest = path;
      }
    }

    return longest;
  }

  /**
   * Get trace summary
   */
  getSummary(): {
    spanCount: number;
    totalDuration: number;
    maxDepth: number;
    averageSpanDuration: number;
  } {
    let spanCount = 0;
    let maxDepth = 0;
    let totalDuration = 0;

    const traverse = (span: Span, depth: number) => {
      spanCount++;
      maxDepth = Math.max(maxDepth, depth);
      totalDuration += span.duration || 0;

      for (const child of span.children) {
        traverse(child, depth + 1);
      }
    };

    if (this.root) {
      traverse(this.root, 0);
    }

    return {
      spanCount,
      totalDuration,
      maxDepth,
      averageSpanDuration: spanCount > 0 ? totalDuration / spanCount : 0,
    };
  }

  /**
   * Clear tracer
   */
  clear(): void {
    this.stack = [];
    this.root = null;
    this.completed = [];
  }

  /**
   * Get completed traces
   */
  getCompleted(): Span[] {
    return this.completed;
  }

  /**
   * Export trace as JSON
   */
  export(): {
    completed: Span[];
    summary: ReturnType<ExecutionTracer["getSummary"]>;
  } {
    return {
      completed: this.completed,
      summary: this.getSummary(),
    };
  }
}

// Global instance
export const globalExecutionTracer = new ExecutionTracer();
