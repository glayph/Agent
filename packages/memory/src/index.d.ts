/* eslint-disable @typescript-eslint/no-explicit-any */
export const TemporalKnowledgeGraph: any;
export const WorkingMemoryAnchor: any;
export const SpecialEventHighlighter: any;
export const MemoryConsolidationDaemon: any;
export const AgentMemoryIntegration: any;
export const TemporaryMemory: any;
export const MultiHopRetriever: any;
export const GraphCognitiveMemory: any;

export const REGIONS: Readonly<{
  LONG_TERM: 'long_term';
  DAILY: 'daily';
  STATIC: 'static';
  SKILL: 'skill';
  RULE_EMOTION: 'rule_emotion';
  TEMPORARY: 'temporary';
}>;
export const ALL_REGIONS: readonly string[];
export const REGION_LABELS: Record<string, string>;
export function isDurableRegion(region: string): boolean;
export const DEFAULT_REGION: string;

export const HashEmbeddingProvider: any;
export const NoopEmbeddingProvider: any;
export const createEmbeddingProvider: any;
export const cosineSimilarity: any;
