/**
 * Type declarations for the graphrag-memory (CommonJS) module, used from
 * the ESM TypeScript @miki/core package via createRequire.
 *
 * Only the surface used by the agent integration is typed here; the full
 * module exports additional methods that are not needed by core.
 */

export interface MemoryEvent {
  id: string;
  chunk_id: string;
  event_type: string;
  content: string;
  source: "user" | "agent" | "tool" | "system";
  importance: number;
  is_special: number;
  metadata: string;
  created_at: string;
}

export interface WorkingAnchor {
  id: string;
  current_timestamp: string;
  current_situation: string | null;
  key_entities: string;
  updated_at: string;
}

export interface ConsolidationReport {
  hoursConsolidated: number;
  daysSummarized: number;
  entitiesArchived: number;
  edgesDeprecated: number;
  dailyEdgesCreated: number;
}

export interface AddRelationResult {
  id: string;
  contradicted: string | null;
  reinforced: boolean;
}

export interface TemporalKnowledgeGraph {
  initialize(): Promise<void>;
  close(): void;
  writeEvent(data: {
    content: string;
    source: string;
    event_type?: string;
    importance?: number;
    metadata?: Record<string, unknown>;
  }): MemoryEvent;
  getContextWindow(queryStr: string, maxEvents?: number): string;
  getWorkingAnchor(): WorkingAnchor;
  getSpecialEvents(limit?: number, activeOnly?: boolean): unknown[];
  runConsolidation(): ConsolidationReport;
  addEntityRelation(
    sourceId: string,
    targetId: string,
    relationType: string,
    metadata?: { factText?: string; weight?: number; [key: string]: unknown },
  ): AddRelationResult;
  _ensureEntity(data: { name: string; type?: string }): string;
  _extractEntities(data: { content: string }): Array<{ name: string; type?: string }>;
  _getHourKey(date?: Date): string;
  _getDateKey(date?: Date): string;
  _now(): string;
  _uuid(): string;
  db: import("better-sqlite3").Database;
}

export interface AgentMemoryIntegration {
  tkg: TemporalKnowledgeGraph;
  preExecutionHook(
    userMessage: string,
    systemState?: Record<string, unknown>,
  ): {
    anchor: WorkingAnchor;
    specialEvents: unknown[];
    contextWindow: string;
    formattedAnchor: string;
    formattedSpecialEvents: string;
  };
  postExecutionHook(
    agentOutput: string,
    userInput: string,
    metadata?: Record<string, unknown>,
  ): MemoryEvent;
  logInteraction(
    userMessage: string,
    agentResponse: string,
    metadata?: Record<string, unknown>,
  ): { userEvent: MemoryEvent; agentEvent: MemoryEvent };
  logToolCall(
    toolName: string,
    args: unknown,
    result: unknown,
    metadata?: Record<string, unknown>,
  ): MemoryEvent;
  getEnhancedSystemPrompt(userMessage: string): string;
}

export interface GraphragMemoryModule {
  TemporalKnowledgeGraph: new (dbPath: string) => TemporalKnowledgeGraph;
  AgentMemoryIntegration: new (
    tkg: TemporalKnowledgeGraph,
  ) => AgentMemoryIntegration;
}
