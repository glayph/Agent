/**
 * Type declarations for the @miki/memory (CommonJS) module, used from
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
  memory_category: MemoryCategory;
  created_at: string;
}

/** The 4 categories writeEvent classifies every event into. */
export type MemoryCategory =
  "long_term" | "daily" | "day_to_day" | "static" | "skill" | "rule_emotion";

/**
 * Actual return shape of writeEvent() / the memory write gateway - a
 * summary of the write, not the full stored row (see MemoryEvent for the
 * row shape as read back by getContextWindow/getEventsByCategory etc).
 * Also returned when the noise filter drops the content (filtered: true),
 * in which case no other fields are set.
 */
export interface WriteEventResult {
  eventId?: string;
  chunkId?: string;
  isSpecial?: boolean;
  specialEventName?: string | null;
  memoryCategory?: MemoryCategory;
  filtered?: boolean;
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

export interface NodeGraphContext {
  id: string;
  key: string;
  kind: string;
  label: string;
  context: Record<string, unknown>;
  accessCount: number;
  activation: number;
  lastUsedAt: string | null;
  score: number;
  text: string;
}

export interface NodeGraphSnapshot {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

export interface SelectiveMemoryItem {
  id: string;
  text: string;
  summary?: string;
  region: string;
  provenance: string;
  confidence: number;
  importance: number;
  score: number;
  lexical: number;
  semantic: number;
  depth: number;
  via?: Record<string, unknown> | null;
  sourceType?: string;
  sourceReference?: string | null;
}

export interface SelectiveMemoryContext {
  items: SelectiveMemoryItem[];
  text: string;
  trace: Record<string, unknown>;
  stats: {
    candidateCount: number;
    selectedCount: number;
    tokensUsed: number;
    maxTokens: number;
    latencyMs: number;
    fallbackReason?: string | null;
  };
}

export interface TemporalKnowledgeGraph {
  initialize(): Promise<void>;
  initializeSync(): void;
  close(): void;
  writeEvent(data: {
    content: string;
    source: string;
    event_type?: string;
    importance?: number;
    metadata?: Record<string, unknown>;
    skipNoiseFilter?: boolean;
  }): WriteEventResult;
  getContextWindow(queryStr: string, maxEvents?: number): string;
  getSelectiveContext(
    queryStr: string,
    options?: Record<string, unknown>,
  ): SelectiveMemoryContext;
  getSelectiveMemoryStats(
    scope?: Record<string, string>,
  ): Record<string, unknown>;
  listSelectiveMemory(
    scope?: Record<string, string>,
    options?: Record<string, unknown>,
  ): Array<Record<string, unknown>>;
  inspectSelectiveMemory(
    scope: Record<string, string>,
    chunkId: string,
  ): Record<string, unknown> | null;
  forgetSelectiveMemory(
    scope: Record<string, string>,
    chunkId: string,
  ): { forgotten: boolean; chunkId: string };
  reindexSelectiveMemory(scope?: Record<string, string>): { reindexed: number };
  getNodeGraphContext(queryStr: string, limit?: number): NodeGraphContext[];
  getNodeGraphSnapshot(limit?: number): NodeGraphSnapshot;
  getWorkingAnchor(): WorkingAnchor;
  getSpecialEvents(limit?: number, activeOnly?: boolean): unknown[];
  getEventsByCategory(category: MemoryCategory, limit?: number): MemoryEvent[];
  getStats(): {
    chunks: unknown[];
    entities: {
      total: number;
      active: number;
      byCategory: Record<MemoryCategory, number>;
    };
    edges: number;
    events: number;
    eventsByCategory: Record<MemoryCategory, number>;
    specialEvents: { total: number; unresolved: number };
    dailySummaries: number;
    nodeGraph: { nodes: number; edges: number; activeNodes: number };
    workingAnchor: { situation: string; entityCount: number };
    timestamp: string;
  };
  runConsolidation(): ConsolidationReport;
  addEntityRelation(
    sourceId: string,
    targetId: string,
    relationType: string,
    metadata?: { factText?: string; weight?: number; [key: string]: unknown },
  ): AddRelationResult;
  _ensureEntity(
    data: { name: string; type?: string },
    memoryCategory?: MemoryCategory,
  ): string;
  _extractEntities(data: {
    content: string;
  }): Array<{ name: string; type?: string }>;
  _getHourKey(date?: Date): string;
  _getDateKey(date?: Date): string;
  _now(): string;
  _uuid(): string;
  MEMORY_CATEGORIES: MemoryCategory[];
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
    selectiveContext?: SelectiveMemoryContext | null;
  };
  postExecutionHook(
    agentOutput: string,
    userInput: string,
    metadata?: Record<string, unknown>,
  ): WriteEventResult;
  logInteraction(
    userMessage: string,
    agentResponse: string,
    metadata?: Record<string, unknown>,
  ): { userEvent: WriteEventResult; agentEvent: WriteEventResult };
  logToolCall(
    toolName: string,
    args: unknown,
    result: unknown,
    metadata?: Record<string, unknown>,
  ): WriteEventResult;
  getEnhancedSystemPrompt(userMessage: string): string;
}

export interface ConsolidationDaemonRunOnceResult {
  consolidation: ConsolidationReport;
  emptyChunksFilled: number;
}

export interface MemoryConsolidationDaemon {
  start(): void;
  stop(): void;
  runOnce(): Promise<ConsolidationDaemonRunOnceResult>;
}

export interface MikiMemoryModule {
  TemporalKnowledgeGraph: new (dbPath: string) => TemporalKnowledgeGraph;
  AgentMemoryIntegration: new (
    tkg: TemporalKnowledgeGraph,
  ) => AgentMemoryIntegration;
  MemoryConsolidationDaemon: new (
    tkg: TemporalKnowledgeGraph,
    options?: {
      checkIntervalMs?: number;
      consolidationIntervalMs?: number;
      fillEmptyChunksIntervalMs?: number;
      maxEmptyChunkLookbackHours?: number;
    },
  ) => MemoryConsolidationDaemon;
}
