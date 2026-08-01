export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ContextUsage {
  used_tokens: number;
  total_tokens: number;
  compress_at_tokens: number;
  used_percent: number;
}

export type StreamEvent =
  | {
      type: "stream_chunk";
      content: string;
      model_name?: string;
      context_usage?: ContextUsage;
    }
  | {
      type: "stream_done";
      usage: { tokens: number };
      agent_loop_id: number;
      model_name?: string;
      context_usage?: ContextUsage;
    }
  | { type: "tool_call"; tool: string; input: unknown }
  | { type: "tool_result"; tool: string; output: string; blocked?: boolean }
  | {
      type: "tool_execution_plan";
      total: number;
      levels: number;
      parallelizable: boolean;
    }
  | {
      type: "tool_concurrency_metrics";
      stats: Record<string, unknown>;
      locks: Record<string, unknown>;
    }
  | { type: "error"; content: string };

export interface AgentConfig {
  agent: {
    name: string;
    project: string;
    persona: string;
    language: string;
    timezone: string;
    memory: {
      short_term_limit: number;
      long_term_enabled: boolean;
      auto_summarize: boolean;
      message_retention_days: number | null;
      vector_search_threshold: number;
      consolidation_batch_size?: number;
      consolidation_debounce_ms?: number;
      max_context_memories?: number;
      max_context_facts?: number;
      max_context_chars?: number;
      prune_low_value_facts?: boolean;
      fact_prune_threshold?: number;
      fact_prune_min_age_days?: number;
    };
    heartbeat: {
      enabled: boolean;
      interval_seconds: number;
      assessments: {
        system_state: boolean;
        scheduled_tasks: boolean;
        memory_consolidation: boolean;
      };
      auto_actions: { enabled: boolean; max_actions_per_cycle: number };
      resource_limits: {
        max_tokens_per_cycle: number;
        max_idle_minutes: number;
      };
    };
    self_improvement: {
      enabled: boolean;
      reflection_interval_minutes: number;
      optimization_interval_minutes: number;
      prompt_tuning_interval_minutes: number;
      max_reflections_per_day: number;
      auto_apply_optimizations?: boolean;
      guardrails: { enabled: boolean; max_prompt_drift_percent: number };
      behavior_learning?: {
        enabled: boolean;
        mode: "observe" | "draft" | "apply";
        exploration_rate: number;
        min_samples: number;
        max_draft_notes: number;
      };
    };
    skill_governance: {
      enabled: boolean;
      demand_analysis_interval_minutes: number;
      auto_prune_interval_minutes: number;
      validator: {
        check_syntax: boolean;
        check_dangerous_patterns: boolean;
        test_execution: boolean;
      };
    };
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMChoiceMessage {
  role?: string;
  content?: string | null;
  tool_calls?: ToolCall[];
}

export interface LLMChoice {
  message?: LLMChoiceMessage;
  finish_reason?: string;
}

export interface LLMUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface LLMResponse {
  choices?: LLMChoice[];
  usage?: LLMUsage;
}
