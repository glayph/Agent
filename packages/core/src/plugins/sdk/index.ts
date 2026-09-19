export const MIKI_PLUGIN_API_VERSION = "1.0" as const;

export type PluginCapability =
  | "ai-provider"
  | "channel"
  | "mcp"
  | "tool"
  | "memory"
  | "search"
  | "browser"
  | "computer-use"
  | "knowledge"
  | "storage"
  | "authentication"
  | "security"
  | "scheduler"
  | "workflow"
  | "code-execution"
  | "integration"
  | "notification"
  | "model-router"
  | "observability"
  | "guardrail"
  | "agent-to-agent";

export type PluginRuntimeStatus =
  | "functional"
  | "partial"
  | "metadata_only"
  | "config_only"
  | "disabled"
  | "unsupported";

export type PluginSource = "builtin" | "external";
export type PluginPermission =
  | "network"
  | "filesystem-read"
  | "filesystem-write"
  | "secrets"
  | "shell"
  | "browser"
  | "computer-use"
  | "mcp"
  | "agent-delegation";

export interface PluginManifest {
  id: string;
  displayName: string;
  version: string;
  apiVersion: typeof MIKI_PLUGIN_API_VERSION;
  capabilities: readonly PluginCapability[];
  runtimeStatus: PluginRuntimeStatus;
  description?: string;
  configKey?: string;
  requiredConfig?: readonly string[];
  secretFields?: readonly string[];
  permissions?: readonly PluginPermission[];
  platform?: readonly ("win32" | "linux" | "darwin" | "any")[];
  metadata?: Readonly<Record<string, unknown>>;
}

export interface PluginContext {
  workspaceDir: string;
  configDir: string;
  dataDir: string;
  mikiVersion: string;
  signal?: AbortSignal;
  getSecret(name: string): string | undefined;
  getService?<T = unknown>(id: string): T | undefined;
  log(event: string, details?: Record<string, unknown>): void;
  audit?(event: string, details?: Record<string, unknown>): void;
}

export interface PluginHealth {
  ok: boolean;
  status: PluginRuntimeStatus;
  latencyMs?: number;
  message?: string;
  details?: Record<string, unknown>;
}

export interface ManagedPlugin {
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
  reload?(config?: unknown): Promise<void> | void;
  health?(): Promise<PluginHealth> | PluginHealth;
}

export interface PluginDescriptor<
  Config = unknown,
  Runtime extends ManagedPlugin = ManagedPlugin,
> {
  manifest: PluginManifest;
  create(context: PluginContext, config?: Config): Promise<Runtime> | Runtime;
  validateConfig?(config: Config): string[];
}

export interface PluginRegistrationError {
  pluginId: string;
  message: string;
}

function cloneManifest(manifest: PluginManifest): PluginManifest {
  return {
    ...manifest,
    capabilities: [...manifest.capabilities],
    requiredConfig: manifest.requiredConfig
      ? [...manifest.requiredConfig]
      : undefined,
    secretFields: manifest.secretFields
      ? [...manifest.secretFields]
      : undefined,
    permissions: manifest.permissions ? [...manifest.permissions] : undefined,
    platform: manifest.platform ? [...manifest.platform] : undefined,
    metadata: manifest.metadata ? { ...manifest.metadata } : undefined,
  };
}

export class PluginRegistry<
  Config = unknown,
  Runtime extends ManagedPlugin = ManagedPlugin,
> {
  private readonly descriptorsById = new Map<
    string,
    PluginDescriptor<Config, Runtime>
  >();

  constructor(descriptors: readonly PluginDescriptor<Config, Runtime>[] = []) {
    for (const descriptor of descriptors) this.register(descriptor);
  }

  register(descriptor: PluginDescriptor<Config, Runtime>): void {
    const id = descriptor.manifest.id.trim();
    if (!id) throw new Error("Plugin manifest id is required.");
    if (descriptor.manifest.apiVersion !== MIKI_PLUGIN_API_VERSION) {
      throw new Error(`Unsupported plugin API version for ${id}.`);
    }
    if (this.descriptorsById.has(id)) {
      throw new Error(`Duplicate plugin registration: ${id}`);
    }
    this.descriptorsById.set(id, descriptor);
  }

  unregister(id: string): boolean {
    return this.descriptorsById.delete(id);
  }

  has(id: string): boolean {
    return this.descriptorsById.has(id);
  }

  get(id: string): PluginDescriptor<Config, Runtime> | undefined {
    return this.descriptorsById.get(id);
  }

  list(): PluginDescriptor<Config, Runtime>[] {
    return [...this.descriptorsById.values()];
  }

  manifests(): PluginManifest[] {
    return this.list().map((descriptor) => cloneManifest(descriptor.manifest));
  }

  async createRuntimes(
    context: PluginContext,
    configs: Readonly<Record<string, Config>> = {},
  ): Promise<Map<string, Runtime>> {
    const runtimes = new Map<string, Runtime>();
    for (const descriptor of this.descriptorsById.values()) {
      const config =
        configs[descriptor.manifest.configKey || descriptor.manifest.id];
      if (descriptor.validateConfig) {
        const errors = descriptor.validateConfig(config as Config);
        if (errors.length > 0) {
          throw new Error(
            `${descriptor.manifest.id} configuration is invalid: ${errors.join("; ")}`,
          );
        }
      }
      runtimes.set(
        descriptor.manifest.id,
        await descriptor.create(context, config),
      );
    }
    return runtimes;
  }
}

export class PluginLifecycleManager<
  Runtime extends ManagedPlugin = ManagedPlugin,
> {
  constructor(
    private readonly runtimes: Map<string, Runtime>,
    private readonly log: (
      event: string,
      details?: Record<string, unknown>,
    ) => void = () => {},
  ) {}

  has(id: string): boolean {
    return this.runtimes.has(id);
  }

  list(): string[] {
    return [...this.runtimes.keys()];
  }

  async startAll(): Promise<PluginRegistrationError[]> {
    const errors: PluginRegistrationError[] = [];
    for (const [pluginId, runtime] of this.runtimes) {
      try {
        await runtime.start?.();
        this.log("plugin.started", { pluginId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ pluginId, message });
        this.log("plugin.start_failed", { pluginId, error: message });
      }
    }
    return errors;
  }

  async reload(
    ids?: readonly string[],
    config?: unknown,
  ): Promise<PluginRegistrationError[]> {
    const selected = ids ? new Set(ids) : new Set(this.runtimes.keys());
    const errors: PluginRegistrationError[] = [];
    for (const pluginId of selected) {
      const runtime = this.runtimes.get(pluginId);
      if (!runtime) continue;
      try {
        if (runtime.reload) await runtime.reload(config);
        else {
          await runtime.stop?.();
          await runtime.start?.();
        }
        this.log("plugin.reloaded", { pluginId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ pluginId, message });
        this.log("plugin.reload_failed", { pluginId, error: message });
      }
    }
    return errors;
  }

  async stopAll(): Promise<PluginRegistrationError[]> {
    const errors: PluginRegistrationError[] = [];
    for (const [pluginId, runtime] of this.runtimes) {
      try {
        await runtime.stop?.();
        this.log("plugin.stopped", { pluginId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ pluginId, message });
        this.log("plugin.stop_failed", { pluginId, error: message });
      }
    }
    return errors;
  }

  async health(): Promise<Record<string, PluginHealth>> {
    const result: Record<string, PluginHealth> = {};
    for (const [pluginId, runtime] of this.runtimes) {
      try {
        result[pluginId] = runtime.health
          ? await runtime.health()
          : { ok: true, status: "functional" };
      } catch (error) {
        result[pluginId] = {
          ok: false,
          status: "partial",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return result;
  }
}

export function pluginManifest(
  manifest: Omit<PluginManifest, "apiVersion">,
): PluginManifest {
  return { apiVersion: MIKI_PLUGIN_API_VERSION, ...manifest };
}
