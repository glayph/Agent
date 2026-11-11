import fs from "node:fs/promises";
import path from "node:path";
import type { AgentPlan, EngineEvent, PlanStep } from "@miki/core/engine";
import { redactSecrets } from "@miki/core/engine";

interface CollectorOptions {
  log?: (message: string, details?: Record<string, unknown>) => void;
  now?: () => Date;
}

interface QueuedEvent {
  event: EngineEvent;
  goal: string;
  receivedAt: string;
}

function safeId(value: string): string {
  const result = value.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return result || "unknown-run";
}

function redactInlineSecrets(value: string): string {
  return redactSecrets(value).replace(
    /\b([\w-]*(?:password|passphrase|api[_ -]?key|access[_ -]?(?:token|key)|refresh[_ -]?token|secret|authorization|cookie|credential|private[_ -]?key)[\w-]*)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    "$1$2[REDACTED]",
  );
}

function scrub(value: unknown, key = "", depth = 0): unknown {
  if (depth > 16) return "[MAX_DEPTH]";
  if (/password|secret|token|api.?key|authorization|cookie|private.?key|credential/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    // Tool arguments are serialized JSON. Parse them so sensitive values are
    // redacted by their actual property names instead of relying on regexes.
    if (key === "arguments" || /^[\[{]/.test(value.trimStart())) {
      try { return JSON.stringify(scrub(JSON.parse(value), "", depth + 1)); }
      catch { /* Keep malformed JSON useful, but still redact inline secrets. */ }
    }
    return redactInlineSecrets(value).slice(0, 12_000);
  }
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => scrub(item, "", depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      scrub(child, childKey, depth + 1),
    ]));
  }
  return value;
}

function markdownPlan(plan: AgentPlan): string {
  const rows = plan.steps.map((step, index) => {
    const deps = step.dependsOn?.length ? ` (depends on: ${step.dependsOn.join(", ")})` : "";
    const tool = step.tool ? ` — tool: \`${step.tool}\`` : "";
    return `${index + 1}. **${redactInlineSecrets(step.title)}**${tool}${deps} — \`${step.status}\``;
  });
  return `# Plan: ${redactInlineSecrets(plan.goal)}\n\n- Plan ID: \`${plan.id}\`\n- Source: ${plan.source}\n- Complexity: ${plan.complexity}\n- Created: ${plan.createdAt}\n\n${rows.join("\n")}\n`;
}

function todoMarkdown(plan: AgentPlan): string {
  const checkbox = (step: PlanStep): string => {
    if (step.status === "done") return "[x]";
    if (step.status === "running") return "[~]";
    if (step.status === "failed") return "[!]";
    if (step.status === "skipped") return "[-]";
    return "[ ]";
  };
  const done = plan.steps.filter((step) => step.status === "done").length;
  const progress = plan.steps.length ? Math.round((done / plan.steps.length) * 100) : 100;
  return `# Todo: ${redactInlineSecrets(plan.goal)}\n\nProgress: ${progress}% (${done}/${plan.steps.length} verified steps)\n\n${plan.steps.map((step) => `- ${checkbox(step)} ${redactInlineSecrets(step.title)}${step.tool ? ` (\`${step.tool}\`)` : ""}`).join("\n")}\n`;
}

/**
 * Backend-only, non-blocking collector for run events and temporary plan/todo
 * files. Its write queue is independent of the agent's planning/execution loop.
 */
export class RunArtifactCollector {
  readonly cacheRoot: string;
  readonly goalRoot: string;
  private readonly queue: QueuedEvent[] = [];
  private readonly plans = new Map<string, AgentPlan>();
  private drainPromise?: Promise<void>;
  private scheduled = false;
  private readonly now: () => Date;

  constructor(dataRoot: string, private readonly options: CollectorOptions = {}) {
    this.cacheRoot = path.join(path.resolve(dataRoot), "Cache");
    this.goalRoot = path.join(path.resolve(dataRoot), "Runtime", "Goals");
    this.now = options.now ?? (() => new Date());
  }

  record(event: EngineEvent, goal: string): void {
    this.queue.push({ event, goal, receivedAt: this.now().toISOString() });
    this.scheduleDrain();
  }

  async flush(): Promise<void> {
    while (this.queue.length || this.drainPromise) {
      if (!this.drainPromise) this.drainPromise = this.drain();
      await this.drainPromise;
    }
  }

  private scheduleDrain(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.flush().catch((error) => this.options.log?.("autonomy.cache_flush_failed", { error: String(error) }));
    });
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        await this.process(item);
      }
    } finally {
      this.drainPromise = undefined;
      if (this.queue.length) this.scheduleDrain();
    }
  }

  private async append(category: string, item: QueuedEvent, payload: unknown): Promise<void> {
    const day = item.receivedAt.slice(0, 10);
    const file = path.join(this.cacheRoot, category, `${day}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const record = {
      schemaVersion: 1,
      at: item.receivedAt,
      runId: item.event.runId,
      goal: redactInlineSecrets(item.goal).slice(0, 4_000),
      eventType: item.event.type,
      payload: scrub(payload),
    };
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private async writePlanFiles(runId: string, plan: AgentPlan, goal: string): Promise<void> {
    const dir = path.join(this.goalRoot, safeId(runId));
    await fs.mkdir(dir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(dir, "plan.md"), markdownPlan(plan), { encoding: "utf8", mode: 0o600 }),
      fs.writeFile(path.join(dir, "todo.md"), todoMarkdown(plan), { encoding: "utf8", mode: 0o600 }),
      fs.writeFile(path.join(dir, "goal.json"), `${JSON.stringify({ runId, goal: redactInlineSecrets(goal), updatedAt: this.now().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }),
    ]);
  }

  private async process(item: QueuedEvent): Promise<void> {
    const event = item.event;
    const payload = scrub(event);
    await this.append("events", item, payload);

    switch (event.type) {
      case "run.started":
        await fs.mkdir(path.join(this.goalRoot, safeId(event.runId)), { recursive: true });
        await this.append("user-input", item, { text: event.goal, sessionId: event.sessionId, source: "run.started" });
        break;
      case "plan.created":
      case "plan.updated":
        this.plans.set(event.runId, structuredClone(event.plan));
        await this.append("plans", item, event.plan);
        await this.append("todo", item, { planId: event.plan.id, steps: event.plan.steps });
        await this.writePlanFiles(event.runId, event.plan, item.goal);
        break;
      case "user.steer":
        await this.append("user-input", item, {
          messages: event.items ?? [],
          count: event.count,
          messageIds: event.messageIds ?? [],
        });
        break;
      case "tool.call":
        await this.append("actions", item, event.call);
        break;
      case "run.phase":
        if (event.phase === "verification") await this.append("verification", item, event);
        else await this.append("recovery", item, event);
        break;
      case "model.retrying":
      case "model.fallback":
      case "model.retry_exhausted":
      case "run.budget":
        await this.append("recovery", item, event);
        break;
      case "run.finished":
        {
          const latestPlan = this.plans.get(event.runId);
          const planVerifiedComplete = !latestPlan || latestPlan.steps.every((step) => step.status === "done");
          if (event.status === "completed" && planVerifiedComplete) {
            await fs.rm(path.join(this.goalRoot, safeId(event.runId)), { recursive: true, force: true });
          }
          this.plans.delete(event.runId);
        }
        break;
      default:
        break;
    }
  }
}
