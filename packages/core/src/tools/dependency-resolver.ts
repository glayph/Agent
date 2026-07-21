/**
 * DependencyResolver: Resolve tool dependencies and execute in optimal order
 * - Build tool dependency graph
 * - Use topological sort to determine execution order
 * - Parallelize independent tools
 * - Cache intermediate results
 */

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  dependencies?: string[]; // IDs of tools this depends on
  priority?: number; // Lower = higher priority
}

export interface ExecutionPlan {
  levels: ToolCall[][]; // Each level can execute in parallel
  totalLevels: number;
  parallelizable: boolean;
}

export class DependencyResolver {
  private resultCache: Map<string, unknown> = new Map();

  private validateTools(tools: ToolCall[]): void {
    const ids = new Set<string>();

    for (const tool of tools) {
      if (!tool.id || typeof tool.id !== "string" || !tool.id.trim()) {
        throw new Error("Tool execution plan contains an empty tool id");
      }
      if (ids.has(tool.id)) {
        throw new Error(`Duplicate tool id in execution plan: ${tool.id}`);
      }
      ids.add(tool.id);
    }

    for (const tool of tools) {
      for (const dependency of tool.dependencies || []) {
        if (!ids.has(dependency)) {
          throw new Error(
            `Tool "${tool.id}" depends on missing tool "${dependency}"`,
          );
        }
        if (dependency === tool.id) {
          throw new Error(`Tool "${tool.id}" cannot depend on itself`);
        }
      }
    }
  }

  /**
   * Resolve dependencies and create execution plan
   */
  resolveDependencies(tools: ToolCall[]): ExecutionPlan {
    this.validateTools(tools);

    // Build dependency graph
    const graph = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();
    const toolMap = new Map<string, ToolCall>();

    // Initialize
    for (const tool of tools) {
      graph.set(tool.id, new Set());
      inDegree.set(tool.id, 0);
      toolMap.set(tool.id, tool);
    }

    // Build edges: if tool A depends on B, then B -> A in graph
    for (const tool of tools) {
      if (tool.dependencies) {
        for (const dep of tool.dependencies) {
          graph.get(dep)!.add(tool.id);
          inDegree.set(tool.id, (inDegree.get(tool.id) || 0) + 1);
        }
      }
    }

    // Topological sort using Kahn's algorithm
    const queue: string[] = Array.from(inDegree.entries())
      .filter(([, degree]) => degree === 0)
      .map(([id]) => id);

    const levels: ToolCall[][] = [];
    let levelCount = 0;

    while (queue.length > 0) {
      const levelSize = queue.length;
      const level: ToolCall[] = [];

      // Process all nodes at current level (can execute in parallel)
      for (let i = 0; i < levelSize; i++) {
        const toolId = queue.shift()!;
        const tool = toolMap.get(toolId);
        if (tool) {
          level.push(tool);
        }

        // Process dependents
        const dependents = graph.get(toolId) || new Set();
        for (const dependent of dependents) {
          inDegree.set(dependent, (inDegree.get(dependent) || 1) - 1);
          if (inDegree.get(dependent) === 0) {
            queue.push(dependent);
          }
        }
      }

      if (level.length > 0) {
        levels.push(level);
        levelCount++;
      }
    }

    // Check for cycles
    const totalProcessed = levels.reduce((sum, level) => sum + level.length, 0);
    if (totalProcessed !== tools.length) {
      throw new Error("Circular dependency detected in tool execution plan");
    }

    const parallelizable = levels.some((level) => level.length > 1);

    return {
      levels,
      totalLevels: levelCount,
      parallelizable,
    };
  }

  /**
   * Execute tools in dependency order
   */
  async executeInOrder(
    tools: ToolCall[],
    executor: (
      tool: ToolCall,
      results: Map<string, unknown>,
    ) => Promise<unknown>,
  ): Promise<Map<string, unknown>> {
    const plan = this.resolveDependencies(tools);
    const results = new Map<string, unknown>();

    for (const level of plan.levels) {
      if (level.length === 1) {
        // Sequential execution
        const tool = level[0];
        const result = await executor(tool, results);
        results.set(tool.id, result);
      } else {
        // Parallel execution
        const promises = level.map((tool) => executor(tool, results));
        const levelResults = await Promise.all(promises);

        for (let i = 0; i < level.length; i++) {
          results.set(level[i].id, levelResults[i]);
        }
      }
    }

    return results;
  }

  /**
   * Get tools that can run in parallel
   */
  getParallelizableGroups(tools: ToolCall[]): ToolCall[][] {
    const plan = this.resolveDependencies(tools);
    return plan.levels.filter((level) => level.length > 1);
  }

  /**
   * Check if tool A depends on tool B (transitively)
   */
  dependsOn(toolA: ToolCall, toolB: ToolCall, tools: ToolCall[]): boolean {
    if (!toolA.dependencies) return false;

    const visited = new Set<string>();
    const queue = [...(toolA.dependencies || [])];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === toolB.id) return true;

      if (visited.has(current)) continue;
      visited.add(current);

      const currentTool = tools.find((t) => t.id === current);
      if (currentTool && currentTool.dependencies) {
        queue.push(...currentTool.dependencies);
      }
    }

    return false;
  }

  /**
   * Optimize execution order by priority
   */
  optimizeByPriority(tools: ToolCall[]): ToolCall[] {
    // Sort by priority within dependency constraints
    const plan = this.resolveDependencies(tools);

    const sorted: ToolCall[] = [];
    for (const level of plan.levels) {
      const levelSorted = [...level].sort(
        (a, b) => (a.priority || 999) - (b.priority || 999),
      );
      sorted.push(...levelSorted);
    }

    return sorted;
  }

  /**
   * Clear result cache
   */
  clearCache(): void {
    this.resultCache.clear();
  }

  /**
   * Get execution stats
   */
  getStats(tools: ToolCall[]): {
    totalTools: number;
    executionLevels: number;
    parallelizationFactor: number;
    criticalPathLength: number;
  } {
    const plan = this.resolveDependencies(tools);
    tools.length / plan.levels.length;
    const parallelFactor = plan.levels.reduce(
      (max, level) => Math.max(max, level.length),
      1,
    );

    return {
      totalTools: tools.length,
      executionLevels: plan.totalLevels,
      parallelizationFactor: parallelFactor,
      criticalPathLength: plan.totalLevels,
    };
  }
}

export const globalDependencyResolver = new DependencyResolver();
