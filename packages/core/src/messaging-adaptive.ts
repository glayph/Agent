import type { ChannelName } from "./event-envelope.js";

export type MessagingStrategy =
  | "single"
  | "streaming"
  | "progressive";

export type OutputMessageKind = "response" | "progress" | "status" | "error";

export interface ChannelMessagingCapabilities {
  maxMessageLength: number;
  supportsMultipleMessages: boolean;
  supportsStreaming: boolean;
  supportsProgress: boolean;
  supportsMarkdown: boolean;
  preservesOrdering: boolean;
}

export interface AdaptiveMessagingConfig {
  adaptive: boolean;
  enableStreaming: boolean;
  enableProgressMessages: boolean;
  avoidUnnecessaryMessages: boolean;
  streamingMinLength: number;
  progressIntervalMs: number;
}

export interface OutputCandidate {
  id: string;
  runId?: string;
  conversationId?: string;
  channel: ChannelName;
  kind: OutputMessageKind;
  content: string;
  sequence?: number;
  createdAt?: number;
  longRunning?: boolean;
  streamingRequested?: boolean;
  stage?: string;
  final?: boolean;
}

export interface PlannedOutputMessage {
  id: string;
  groupId: string;
  sequence: number;
  total: number;
  strategy: MessagingStrategy;
  channel: ChannelName;
  kind: OutputMessageKind;
  content: string;
  runId?: string;
  conversationId?: string;
  final: boolean;
  stream?: boolean;
}

export interface MessageGroupState {
  groupId: string;
  nextSequence: number;
  emitted: Set<string>;
  lastProgressAt: number;
}

export const DEFAULT_ADAPTIVE_MESSAGING_CONFIG: AdaptiveMessagingConfig = {
  adaptive: true,
  enableStreaming: true,
  enableProgressMessages: true,
  avoidUnnecessaryMessages: true,
  streamingMinLength: 1200,
  progressIntervalMs: 1800,
};

const DEFAULT_CAPABILITIES: Record<ChannelName, ChannelMessagingCapabilities> = {
  web: {
    maxMessageLength: 12000,
    supportsMultipleMessages: true,
    supportsStreaming: true,
    supportsProgress: true,
    supportsMarkdown: true,
    preservesOrdering: true,
  },
  webhook: {
    maxMessageLength: 12000,
    supportsMultipleMessages: true,
    supportsStreaming: false,
    supportsProgress: false,
    supportsMarkdown: true,
    preservesOrdering: true,
  },
  api: {
    maxMessageLength: 12000,
    supportsMultipleMessages: true,
    supportsStreaming: true,
    supportsProgress: true,
    supportsMarkdown: true,
    preservesOrdering: true,
  },
  timer: {
    maxMessageLength: 12000,
    supportsMultipleMessages: true,
    supportsStreaming: false,
    supportsProgress: false,
    supportsMarkdown: true,
    preservesOrdering: true,
  },
  telegram: {
    maxMessageLength: 4096,
    supportsMultipleMessages: true,
    supportsStreaming: false,
    supportsProgress: true,
    supportsMarkdown: true,
    preservesOrdering: true,
  },
  whatsapp: {
    maxMessageLength: 4096,
    supportsMultipleMessages: true,
    supportsStreaming: false,
    supportsProgress: true,
    supportsMarkdown: false,
    preservesOrdering: true,
  },
  discord: {
    maxMessageLength: 2000,
    supportsMultipleMessages: true,
    supportsStreaming: false,
    supportsProgress: true,
    supportsMarkdown: true,
    preservesOrdering: true,
  },
  slack: {
    maxMessageLength: 4000,
    supportsMultipleMessages: true,
    supportsStreaming: false,
    supportsProgress: true,
    supportsMarkdown: true,
    preservesOrdering: true,
  },
  email: {
    maxMessageLength: 20000,
    supportsMultipleMessages: false,
    supportsStreaming: false,
    supportsProgress: false,
    supportsMarkdown: true,
    preservesOrdering: true,
  },
};

export function getChannelMessagingCapabilities(
  channel: ChannelName,
  overrides?: Partial<ChannelMessagingCapabilities>,
): ChannelMessagingCapabilities {
  return { ...DEFAULT_CAPABILITIES[channel], ...overrides };
}

export function normalizeMessagingConfig(
  input?: Partial<AdaptiveMessagingConfig>,
): AdaptiveMessagingConfig {
  const next = { ...DEFAULT_ADAPTIVE_MESSAGING_CONFIG, ...(input ?? {}) };
  next.streamingMinLength = Math.max(256, Math.floor(next.streamingMinLength));
  next.progressIntervalMs = Math.max(500, Math.floor(next.progressIntervalMs));
  return next;
}

export function chooseMessagingStrategy(
  candidate: OutputCandidate,
  capabilities: ChannelMessagingCapabilities,
  config: Partial<AdaptiveMessagingConfig> = DEFAULT_ADAPTIVE_MESSAGING_CONFIG,
): MessagingStrategy {
  const cfg = normalizeMessagingConfig(config);
  const content = candidate.content.trim();
  if (!content) return candidate.kind === "progress" ? "progressive" : "single";

  if (candidate.kind === "progress" || candidate.kind === "status") {
    return cfg.enableProgressMessages && capabilities.supportsProgress
      ? "progressive"
      : "single";
  }

  if (
    candidate.streamingRequested &&
    candidate.longRunning &&
    cfg.enableStreaming &&
    capabilities.supportsStreaming
  ) {
    return "streaming";
  }

  // A message is never split automatically: one reply stays one message at any length.
  return "single";
}

export function planAdaptiveOutput(
  candidate: OutputCandidate,
  capabilities = getChannelMessagingCapabilities(candidate.channel),
  config: Partial<AdaptiveMessagingConfig> = DEFAULT_ADAPTIVE_MESSAGING_CONFIG,
): PlannedOutputMessage[] {
  const cfg = normalizeMessagingConfig(config);
  const content = candidate.content.trim();
  if (!content) return [];
  const strategy = chooseMessagingStrategy(candidate, capabilities, cfg);
  const groupId = `${candidate.runId ?? "conversation"}:${candidate.id}`;
  const base = {
    groupId,
    channel: candidate.channel,
    kind: candidate.kind,
    runId: candidate.runId,
    conversationId: candidate.conversationId,
  };

  return [{
    ...base,
    id: `${candidate.id}:1`,
    sequence: 1,
    total: 1,
    strategy,
    content,
    final: candidate.final !== false,
    ...(strategy === "streaming" ? { stream: true } : {}),
  }];
}

export function progressAllowed(
  state: MessageGroupState,
  now = Date.now(),
  intervalMs = DEFAULT_ADAPTIVE_MESSAGING_CONFIG.progressIntervalMs,
): boolean {
  if (now - state.lastProgressAt < intervalMs) return false;
  state.lastProgressAt = now;
  return true;
}

export class AdaptiveMessageCoordinator {
  private readonly groups = new Map<string, MessageGroupState>();

  constructor(
    private readonly config: Partial<AdaptiveMessagingConfig> = DEFAULT_ADAPTIVE_MESSAGING_CONFIG,
  ) {}

  plan(candidate: OutputCandidate, capabilities?: ChannelMessagingCapabilities): PlannedOutputMessage[] {
    const planned = planAdaptiveOutput(candidate, capabilities ?? getChannelMessagingCapabilities(candidate.channel), this.config);
    const groupId = planned[0]?.groupId;
    if (!groupId) return [];
    const state = this.groups.get(groupId) ?? {
      groupId,
      nextSequence: 1,
      emitted: new Set<string>(),
      lastProgressAt: 0,
    };
    const filtered = planned.filter((item) => !state.emitted.has(item.id));
    this.groups.set(groupId, state);
    return filtered;
  }

  markEmitted(message: PlannedOutputMessage): void {
    const state = this.groups.get(message.groupId) ?? {
      groupId: message.groupId,
      nextSequence: 1,
      emitted: new Set<string>(),
      lastProgressAt: 0,
    };
    state.emitted.add(message.id);
    state.nextSequence = Math.max(state.nextSequence, message.sequence + 1);
    this.groups.set(message.groupId, state);
  }

  canEmitProgress(groupId: string, now = Date.now()): boolean {
    const state = this.groups.get(groupId) ?? {
      groupId,
      nextSequence: 1,
      emitted: new Set<string>(),
      lastProgressAt: 0,
    };
    const allowed = progressAllowed(state, now, normalizeMessagingConfig(this.config).progressIntervalMs);
    this.groups.set(groupId, state);
    return allowed;
  }
}
