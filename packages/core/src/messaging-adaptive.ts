import type { ChannelName } from "./event-envelope.js";

export type MessagingStrategy =
  | "single"
  | "multi_message"
  | "chunked"
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
  maxMessagesPerResponse: number;
  enableChunking: boolean;
  enableStreaming: boolean;
  enableProgressMessages: boolean;
  maxChunkLength: number;
  avoidUnnecessaryMessages: boolean;
  streamingMinLength: number;
  multiMessageMinLength: number;
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
  maxMessagesPerResponse: 3,
  enableChunking: true,
  enableStreaming: true,
  enableProgressMessages: true,
  maxChunkLength: 4000,
  avoidUnnecessaryMessages: true,
  streamingMinLength: 1200,
  multiMessageMinLength: 800,
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
  next.maxMessagesPerResponse = Math.max(1, Math.min(3, Math.floor(next.maxMessagesPerResponse)));
  next.maxChunkLength = Math.max(256, Math.floor(next.maxChunkLength));
  next.streamingMinLength = Math.max(256, Math.floor(next.streamingMinLength));
  next.multiMessageMinLength = Math.max(256, Math.floor(next.multiMessageMinLength));
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

  const limit = Math.min(capabilities.maxMessageLength, cfg.maxChunkLength);
  if (content.length > limit && cfg.enableChunking) return "chunked";

  const sections = splitLogicalSections(content);
  if (
    cfg.adaptive &&
    cfg.maxMessagesPerResponse > 1 &&
    capabilities.supportsMultipleMessages &&
    content.length >= cfg.multiMessageMinLength &&
    sections.length >= 2
  ) {
    return "multi_message";
  }

  return "single";
}

export function splitLogicalSections(content: string): string[] {
  const blocks = splitPreservingCodeAndTables(content)
    .map((block) => block.trim())
    .filter(Boolean);
  const sections: string[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const current = blocks[index];
    if (/^#{1,6}\s+/.test(current) && index + 1 < blocks.length) {
      sections.push(`${current}\n\n${blocks[index + 1]}`.trim());
      index += 1;
      continue;
    }
    sections.push(current);
  }
  return sections;
}

/**
 * Split on semantic blank-line boundaries while treating fenced code and
 * markdown tables as indivisible blocks. This deliberately prefers a slightly
 * oversized block to corrupting a command, JSON, URL, table, or code fence.
 */
export function splitPreservingCodeAndTables(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    if (current.length) {
      blocks.push(current.join("\n").trim());
      current = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.test(line);
    const table = isMarkdownTableStart(lines, i);

    if (fence) {
      inFence = !inFence;
      current.push(line);
      i += 1;
      if (!inFence) flush();
      continue;
    }

    if (inFence) {
      current.push(line);
      i += 1;
      continue;
    }

    if (table) {
      flush();
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        tableLines.push(lines[i]);
        i += 1;
      }
      blocks.push(tableLines.join("\n").trim());
      while (i < lines.length && !lines[i].trim()) i += 1;
      continue;
    }

    if (!line.trim()) {
      flush();
      i += 1;
      continue;
    }

    current.push(line);
    i += 1;
  }
  flush();
  return blocks;
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  const header = lines[index].trim();
  const separator = lines[index + 1].trim();
  return header.includes("|") && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(separator);
}

function mergeSectionsForMessageCount(sections: string[], maxMessages: number): string[] {
  if (sections.length <= maxMessages) return sections;
  const limit = Math.max(2, maxMessages);
  const groups: string[] = [];
  const remaining = [...sections];
  for (let index = 0; index < limit; index += 1) {
    const remainingGroups = limit - index;
    const take = Math.max(1, Math.ceil(remaining.length / remainingGroups));
    groups.push(remaining.splice(0, take).join("\n\n"));
  }
  return groups.filter(Boolean);
}

function splitOversizeBlock(block: string, maxLength: number): string[] {
  if (block.length <= maxLength) return [block];
  if (/^\s*(```|~~~)[\s\S]*\1\s*$/.test(block)) return [block];
  if (block.includes("|") && block.split("\n").length > 1 && /^\|?/.test(block)) {
    return [block];
  }
  const tokens = block.split(/\s+/);
  if (tokens.some((token) => token.length > maxLength || /^https?:\/\//i.test(token))) {
    return [block];
  }
  const pieces: string[] = [];
  let remaining = block;
  while (remaining.length > maxLength) {
    const target = remaining.slice(0, maxLength + 1);
    let cut = Math.max(target.lastIndexOf("\n"), target.lastIndexOf("\n\n"));
    if (cut < maxLength * 0.55) cut = target.lastIndexOf(" ");
    if (cut < maxLength * 0.55) cut = maxLength;
    pieces.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

export function chunkContent(content: string, maxLength: number): string[] {
  const limit = Math.max(256, Math.floor(maxLength));
  const sections = splitPreservingCodeAndTables(content);
  if (!sections.length) return [];
  const chunks: string[] = [];
  let current = "";
  for (const section of sections) {
    for (const piece of splitOversizeBlock(section, limit)) {
      if (!current) {
        current = piece;
      } else if (current.length + 2 + piece.length <= limit) {
        current = `${current}\n\n${piece}`;
      } else {
        chunks.push(current);
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
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

  if (strategy === "single" || strategy === "streaming" || strategy === "progressive") {
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

  const sections = strategy === "multi_message"
    ? mergeSectionsForMessageCount(splitLogicalSections(content), cfg.maxMessagesPerResponse)
    : chunkContent(content, Math.min(capabilities.maxMessageLength, cfg.maxChunkLength));

  return sections.map((section, index) => ({
    ...base,
    id: `${candidate.id}:${index + 1}`,
    sequence: index + 1,
    total: sections.length,
    strategy,
    content: section,
    final: candidate.final !== false && index === sections.length - 1,
  }));
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
