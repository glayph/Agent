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
  /** Optional local icon registry key for the Monitoring graph; external URLs are not accepted. */
  monitorIconKey?: string;
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
  /** Whether this result came from a runtime probe or only manifest metadata. */
  source?: "live_probe" | "manifest_only" | "not_checked";
  checkedAt?: string;
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

const PLUGIN_CAPABILITIES = new Set<PluginCapability>([
  "ai-provider", "channel", "mcp", "tool", "memory", "search", "browser",
  "computer-use", "knowledge", "storage", "authentication", "security",
  "scheduler", "workflow", "code-execution", "integration", "notification",
  "model-router", "observability", "guardrail", "agent-to-agent",
]);
const PLUGIN_STATUSES = new Set<PluginRuntimeStatus>([
  "functional", "partial", "metadata_only", "config_only", "disabled", "unsupported",
]);
const PLUGIN_PERMISSIONS = new Set<PluginPermission>([
  "network", "filesystem-read", "filesystem-write", "secrets", "shell",
  "browser", "computer-use", "mcp", "agent-delegation",
]);
const PLUGIN_PLATFORMS = new Set(["win32", "linux", "darwin", "any"]);

function cloneManifest(manifest: PluginManifest): PluginManifest {
  return {
    ...manifest,
    capabilities: [...(manifest.capabilities ?? [])],
    requiredConfig: manifest.requiredConfig ? [...manifest.requiredConfig] : undefined,
    secretFields: manifest.secretFields ? [...manifest.secretFields] : undefined,
    permissions: manifest.permissions ? [...manifest.permissions] : undefined,
    platform: manifest.platform ? [...manifest.platform] : undefined,
    metadata: manifest.metadata ? { ...manifest.metadata } : undefined,
  };
}

function uniqueStrings(values: readonly unknown[]): boolean {
  return values.every((value) => typeof value === "string" && value.trim().length > 0)
    && new Set(values).size === values.length;
}

/** Runtime validation protects the plugin boundary even when manifests come from untyped JS. */
export function validatePluginManifest(manifest: PluginManifest): string[] {
  const errors: string[] = [];
  const id = typeof manifest?.id === "string" ? manifest.id : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) errors.push("id must be a lowercase slug of 1–64 characters.");
  if (typeof manifest?.displayName !== "string" || !manifest.displayName.trim() || manifest.displayName.length > 120) {
    errors.push("displayName must contain 1–120 characters.");
  }
  if (typeof manifest?.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    errors.push("version must be a valid semantic version.");
  }
  if (manifest?.apiVersion !== MIKI_PLUGIN_API_VERSION) errors.push("apiVersion is unsupported.");
  if (!Array.isArray(manifest?.capabilities) || manifest.capabilities.length === 0
    || !uniqueStrings(manifest.capabilities)
    || manifest.capabilities.some((value) => !PLUGIN_CAPABILITIES.has(value as PluginCapability))) {
    errors.push("capabilities must be a non-empty list of unique supported values.");
  }
  if (!PLUGIN_STATUSES.has(manifest?.runtimeStatus)) errors.push("runtimeStatus is unsupported.");
  if (manifest?.requiredConfig && (!Array.isArray(manifest.requiredConfig) || !uniqueStrings(manifest.requiredConfig))) {
    errors.push("requiredConfig must contain unique non-empty strings.");
  }
  if (manifest?.secretFields && (!Array.isArray(manifest.secretFields) || !uniqueStrings(manifest.secretFields))) {
    errors.push("secretFields must contain unique non-empty strings.");
  }
  if (manifest?.permissions && (!Array.isArray(manifest.permissions) || !uniqueStrings(manifest.permissions)
    || manifest.permissions.some((value) => !PLUGIN_PERMISSIONS.has(value as PluginPermission)))) {
    errors.push("permissions contains an unsupported value or duplicate.");
  }
  if (manifest?.platform && (!Array.isArray(manifest.platform) || !uniqueStrings(manifest.platform)
    || manifest.platform.some((value) => !PLUGIN_PLATFORMS.has(value)))) {
    errors.push("platform contains an unsupported value or duplicate.");
  }
  if (manifest?.configKey !== undefined && (typeof manifest.configKey !== "string" || !manifest.configKey.trim())) {
    errors.push("configKey must be a non-empty string when supplied.");
  }
  return errors;
}

function freezeManifest(manifest: PluginManifest): PluginManifest {
  const copy = cloneManifest(manifest);
  if (copy.metadata) Object.freeze(copy.metadata);
  Object.freeze(copy.capabilities);
  if (copy.requiredConfig) Object.freeze(copy.requiredConfig);
  if (copy.secretFields) Object.freeze(copy.secretFields);
  if (copy.permissions) Object.freeze(copy.permissions);
  if (copy.platform) Object.freeze(copy.platform);
  return Object.freeze(copy);
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
    if (!descriptor || typeof descriptor !== "object" || typeof descriptor.create !== "function") {
      throw new Error("Plugin descriptor must provide a create() function.");
    }
    const manifest = descriptor.manifest;
    const id = typeof manifest?.id === "string" ? manifest.id.trim() : "";
    if (manifest?.apiVersion !== MIKI_PLUGIN_API_VERSION) {
      throw new Error(`Unsupported plugin API version for ${id || "unknown plugin"}.`);
    }
    const validationErrors = validatePluginManifest(manifest);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid plugin manifest for ${id || "unknown plugin"}: ${validationErrors.join("; ")}`);
    }
    if (this.descriptorsById.has(id)) {
      throw new Error(`Duplicate plugin registration: ${id}`);
    }
    const stableDescriptor = Object.freeze({
      ...descriptor,
      manifest: freezeManifest(manifest),
    }) as PluginDescriptor<Config, Runtime>;
    this.descriptorsById.set(id, stableDescriptor);
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
    try {
      for (const descriptor of this.descriptorsById.values()) {
        const config = configs[descriptor.manifest.configKey || descriptor.manifest.id];
        if (descriptor.validateConfig) {
          const errors = descriptor.validateConfig(config as Config);
          if (errors.length > 0) {
            throw new Error(`${descriptor.manifest.id} configuration is invalid: ${errors.join("; ")}`);
          }
        }
        runtimes.set(descriptor.manifest.id, await descriptor.create(context, config));
      }
      return runtimes;
    } catch (error) {
      const cleanupErrors: string[] = [];
      for (const [pluginId, runtime] of [...runtimes.entries()].reverse()) {
        try { await runtime.stop?.(); }
        catch (cleanupError) {
          cleanupErrors.push(`${pluginId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
      }
      const reason = error instanceof Error ? error.message : String(error);
      const cleanup = cleanupErrors.length ? ` Cleanup failures: ${cleanupErrors.join("; ")}` : "";
      throw new Error(`Plugin runtime creation failed: ${reason}.${cleanup}`);
    }
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
