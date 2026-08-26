import { builtinCapabilityRegistry } from "./builtin-plugin-catalog.js";
import {
  PluginLifecycleManager,
  PluginRegistry,
  type ManagedPlugin,
  type PluginContext,
  type PluginDescriptor,
  type PluginHealth,
} from "./sdk/index.js";
import type { RuntimePaths } from "../paths.js";

const CORE_OWNED_STATEFUL_PLUGINS = new Set([
  "mcp.server",
  "memory.temporal-knowledge-graph",
  // api/index.ts owns the request-scoped search router; activating a second
  // router here would duplicate cloud configuration and fallback state.
  "search.local-first",
  "storage.core",
  "security.policy-kernel",
  "scheduler.core",
  "workflow.project",
  "integrations.platform",
  "notifications.core",
  "observability.core",
  "guardrails.core",
]);

export interface CoreCapabilityPluginHostOptions {
  paths: RuntimePaths;
  mikiVersion?: string;
  services?: () => Readonly<Record<string, unknown>>;
  getSecret?: (name: string) => string | undefined;
  log?: (event: string, details?: Record<string, unknown>) => void;
}

export class CoreCapabilityPluginHost {
  private readonly registry: PluginRegistry;
  private lifecycle: PluginLifecycleManager | null = null;
  private runtimes = new Map<string, ManagedPlugin>();
  private activation: Promise<void> | null = null;

  constructor(private readonly options: CoreCapabilityPluginHostOptions) {
    const descriptors = builtinCapabilityRegistry
      .list()
      .filter(
        (descriptor) =>
          !CORE_OWNED_STATEFUL_PLUGINS.has(descriptor.manifest.id),
      );
    this.registry = new PluginRegistry(descriptors as PluginDescriptor[]);
  }

  manifests() {
    return this.registry.manifests();
  }

  isActive(id: string): boolean {
    return this.runtimes.has(id);
  }

  get<T extends ManagedPlugin = ManagedPlugin>(id: string): T | undefined {
    return this.runtimes.get(id) as T | undefined;
  }

  async start(): Promise<void> {
    if (this.activation) return this.activation;
    this.activation = this.activate();
    try {
      await this.activation;
    } finally {
      this.activation = null;
    }
  }

  private async activate(): Promise<void> {
    const context: PluginContext = {
      workspaceDir: this.options.paths.sourceDir || this.options.paths.dataDir,
      configDir: this.options.paths.configDir,
      dataDir: this.options.paths.dataDir,
      mikiVersion: this.options.mikiVersion || "unknown",
      getSecret: (name) => this.options.getSecret?.(name),
      getService: <T>(id: string) =>
        this.options.services?.()[id] as T | undefined,
      log: this.options.log || (() => {}),
    };
    this.runtimes = await this.registry.createRuntimes(context);
    this.lifecycle = new PluginLifecycleManager(
      this.runtimes,
      this.options.log,
    );
    const errors = await this.lifecycle.startAll();
    if (errors.length > 0) {
      this.options.log?.("plugins.start_partial", { errors });
    }
  }

  async reload(): Promise<void> {
    if (!this.lifecycle) return this.start();
    const errors = await this.lifecycle.reload();
    if (errors.length > 0)
      this.options.log?.("plugins.reload_partial", { errors });
  }

  async stop(): Promise<void> {
    if (!this.lifecycle) return;
    const errors = await this.lifecycle.stopAll();
    if (errors.length > 0)
      this.options.log?.("plugins.stop_partial", { errors });
    this.lifecycle = null;
    this.runtimes.clear();
  }

  async health(): Promise<Record<string, PluginHealth>> {
    return this.lifecycle?.health() || {};
  }
}

export { CORE_OWNED_STATEFUL_PLUGINS };
