/**
 * ContextualToolPruner: Reduce tool selection hallucination
 * - Infer task context from query
 * - Dynamically disable irrelevant tools
 * - Show agent only relevant tools + fallbacks
 * - Learn tool relevance patterns
 */

export interface ToolRelevance {
  toolName: string;
  context: string;
  relevance: number;
  uses: number;
}

export interface Tool {
  name?: string;
  description?: string;
  category?: string;
  function?: {
    name: string;
    description?: string;
  };
}

export class ContextualToolPruner {
  private toolRelevance: Map<string, ToolRelevance[]> = new Map();
  private contextInference: Map<string, string[]> = new Map();

  private readonly TOP_K = 5;
  private readonly FALLBACK_TOOLS = ["memory_search", "web_search", "ask_user"];
  private readonly RELEVANCE_THRESHOLD = 0.4;
  private readonly CONTEXT_KEYWORDS: Record<string, string[]> = {
    creation: ["create", "write", "generate", "compose", "draft"],
    data_analysis: ["data", "query", "sql", "analytics", "table", "chart"],
    general: ["help", "answer", "assist", "status"],
    learning: ["learn", "explain", "understand", "summarize", "teach"],
    programming: [
      "code",
      "debug",
      "file",
      "git",
      "programming",
      "test",
      "build",
      "lint",
    ],
    research: ["research", "find", "search", "web", "source", "crawl"],
    vision: ["image", "screenshot", "vision", "browser", "screen"],
  };

  /**
   * Infer context from query
   */
  private inferContext(query: string): string {
    const lower = query.toLowerCase();

    // Context inference heuristics
    if (
      lower.includes("code") ||
      lower.includes("debug") ||
      lower.includes("programming")
    ) {
      return "programming";
    }
    if (lower.includes("data") || lower.includes("analytics")) {
      return "data_analysis";
    }
    if (lower.includes("image") || lower.includes("vision")) {
      return "vision";
    }
    if (lower.includes("learn") || lower.includes("understand")) {
      return "learning";
    }
    if (lower.includes("write") || lower.includes("create")) {
      return "creation";
    }
    if (lower.includes("research") || lower.includes("find")) {
      return "research";
    }

    return "general";
  }

  /**
   * Get pruned tool set for query
   */
  getPrunedToolset<T extends Tool>(query: string, allTools: T[]): T[] {
    const context = this.inferContext(query);

    // Score tools by relevance to context
    const scored = allTools.map((tool) => ({
      tool,
      score: this.scoreToolRelevance(tool, context),
    }));

    // Keep top K tools
    const topK = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, this.TOP_K)
      .filter((s) => s.score >= this.RELEVANCE_THRESHOLD)
      .map((s) => s.tool);

    // Add fallback tools
    const pruned = Array.from(
      new Map(
        [
          ...topK,
          ...allTools.filter((t) =>
            this.FALLBACK_TOOLS.includes(this.getToolName(t)),
          ),
        ].map((t) => [this.getToolName(t), t]),
      ).values(),
    );

    return pruned;
  }

  private getToolName(tool: Tool): string {
    return tool.name || tool.function?.name || "";
  }

  /**
   * Score tool relevance for a context
   */
  private scoreToolRelevance(tool: Tool | string, context: string): number {
    const toolName = typeof tool === "string" ? tool : this.getToolName(tool);
    if (!this.toolRelevance.has(toolName)) {
      return typeof tool === "string"
        ? 0.2
        : this.semanticToolScore(tool, context);
    }

    const history = this.toolRelevance.get(toolName) || [];
    const relevant = history.filter((h) => h.context === context);

    if (relevant.length === 0) {
      return typeof tool === "string"
        ? 0.2
        : this.semanticToolScore(tool, context);
    }

    const avgRelevance =
      relevant.reduce((sum, h) => sum + h.relevance, 0) / relevant.length;
    const semantic =
      typeof tool === "string" ? 0 : this.semanticToolScore(tool, context);
    return Math.max(avgRelevance, semantic);
  }

  private semanticToolScore(tool: Tool, context: string): number {
    const name = this.getToolName(tool).toLowerCase();
    const text = [
      name,
      tool.description || "",
      tool.category || "",
      tool.function?.description || "",
    ]
      .join(" ")
      .toLowerCase();
    const keywords = this.CONTEXT_KEYWORDS[context] || [];
    let score = this.FALLBACK_TOOLS.includes(name) ? 0.8 : 0.2;

    for (const keyword of keywords) {
      if (name.includes(keyword)) score += 0.25;
      else if (text.includes(keyword)) score += 0.15;
    }

    return Math.min(1, score);
  }

  /**
   * Record tool usage feedback
   */
  recordToolUsage(
    toolName: string,
    context: string,
    wasRelevant: boolean,
  ): void {
    if (!this.toolRelevance.has(toolName)) {
      this.toolRelevance.set(toolName, []);
    }

    const history = this.toolRelevance.get(toolName)!;

    // Update existing entry or add new
    const existing = history.find((h) => h.context === context);
    if (existing) {
      existing.relevance =
        (existing.relevance * existing.uses + (wasRelevant ? 1 : 0)) /
        (existing.uses + 1);
      existing.uses++;
    } else {
      history.push({
        toolName,
        context,
        relevance: wasRelevant ? 1 : 0,
        uses: 1,
      });
    }
  }

  /**
   * Get tool relevance score for context
   */
  getToolScore(toolName: string, context: string): number {
    return this.scoreToolRelevance(toolName, context);
  }

  /**
   * Get all tool scores for a context
   */
  getAllToolScores(context: string): Array<{ tool: string; score: number }> {
    const scores: Array<{ tool: string; score: number }> = [];

    for (const [toolName] of this.toolRelevance) {
      scores.push({
        tool: toolName,
        score: this.scoreToolRelevance(toolName, context),
      });
    }

    return scores.sort((a, b) => b.score - a.score);
  }

  /**
   * Learn context patterns from queries
   */
  learnContextPatterns(query: string, tools: string[]): void {
    const context = this.inferContext(query);

    if (!this.contextInference.has(context)) {
      this.contextInference.set(context, []);
    }

    const contextTools = this.contextInference.get(context)!;
    for (const tool of tools) {
      if (!contextTools.includes(tool)) {
        contextTools.push(tool);
      }
    }
  }

  /**
   * Get expected tools for a context
   */
  getContextTools(context: string): string[] {
    return this.contextInference.get(context) || [];
  }

  /**
   * Export learning data
   */
  exportLearning(): {
    toolRelevance: Record<string, ToolRelevance[]>;
    contextPatterns: Record<string, string[]>;
  } {
    const toolRelevance: Record<string, ToolRelevance[]> = {};
    for (const [tool, history] of this.toolRelevance) {
      toolRelevance[tool] = history;
    }

    const contextPatterns: Record<string, string[]> = {};
    for (const [context, tools] of this.contextInference) {
      contextPatterns[context] = tools;
    }

    return { toolRelevance, contextPatterns };
  }

  /**
   * Clear learning
   */
  clear(): void {
    this.toolRelevance.clear();
    this.contextInference.clear();
  }
}

export const globalContextualToolPruner = new ContextualToolPruner();
