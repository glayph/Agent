import type { Router } from "express";
import type { AgentOrchestrator } from "../../../agent.js";
import type {
  ChannelRuntimeStatus,
  SupportedChannelMetadata,
  ChannelRuntimeProbeCheck,
} from "../../../api/channel-runtime-probe.js";

export const MIKI_CHANNEL_PLUGIN_API_VERSION = "1.0" as const;

export interface ChannelPluginManifest extends SupportedChannelMetadata {
  api_version: typeof MIKI_CHANNEL_PLUGIN_API_VERSION;
  required_fields: string[];
  secret_fields: string[];
  env_fields?: Record<string, string>;
  webhook_path?: string;
  probe_config?: (
    config: Record<string, unknown>,
    configuredSecrets: ReadonlySet<string>,
  ) => ChannelRuntimeProbeCheck[];
}

export interface ManagedChannelRuntime {
  start(): void;
  stop(): void;
}

export interface BuiltinChannelPlugin {
  manifest: ChannelPluginManifest;
  createRuntime?: (orchestrator: AgentOrchestrator) => ManagedChannelRuntime;
  createRouter?: (orchestrator: AgentOrchestrator) => Router;
}

export interface MountedChannelRouter {
  channel: string;
  path: string;
  router: Router;
}

export class ChannelPluginRegistry {
  private readonly pluginsByName: Map<string, BuiltinChannelPlugin>;

  constructor(private readonly plugins: readonly BuiltinChannelPlugin[]) {
    this.pluginsByName = new Map();
    for (const plugin of plugins) {
      const name = plugin.manifest.name;
      if (this.pluginsByName.has(name)) {
        throw new Error(`Duplicate built-in channel Plug-in: ${name}`);
      }
      if (plugin.manifest.config_key !== name) {
        throw new Error(
          `Channel Plug-in ${name} must use its name as config_key for compatibility.`,
        );
      }
      this.pluginsByName.set(name, plugin);
    }
  }

  list(): BuiltinChannelPlugin[] {
    return [...this.plugins];
  }

  manifests(): ChannelPluginManifest[] {
    return this.plugins.map((plugin) => ({
      ...plugin.manifest,
      required_fields: [...plugin.manifest.required_fields],
      secret_fields: [...plugin.manifest.secret_fields],
      env_fields: plugin.manifest.env_fields
        ? { ...plugin.manifest.env_fields }
        : undefined,
      probe_config: plugin.manifest.probe_config,
    }));
  }

  get(name: string): BuiltinChannelPlugin | undefined {
    return this.pluginsByName.get(name);
  }

  createRuntimes(
    orchestrator: AgentOrchestrator,
  ): Map<string, ManagedChannelRuntime> {
    const runtimes = new Map<string, ManagedChannelRuntime>();
    for (const plugin of this.plugins) {
      if (plugin.createRuntime) {
        runtimes.set(plugin.manifest.name, plugin.createRuntime(orchestrator));
      }
    }
    return runtimes;
  }

  createRouters(orchestrator: AgentOrchestrator): MountedChannelRouter[] {
    const mounted: MountedChannelRouter[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.createRouter || !plugin.manifest.webhook_path) continue;
      mounted.push({
        channel: plugin.manifest.name,
        path: plugin.manifest.webhook_path,
        router: plugin.createRouter(orchestrator),
      });
    }
    return mounted;
  }
}

export class ChannelPluginLifecycleManager {
  constructor(
    private readonly runtimes: Map<string, ManagedChannelRuntime>,
    private readonly externalRuntime?: {
      startAll(): Promise<void> | void;
      reload(names: string[]): Promise<void> | void;
      stopAll(): Promise<void> | void;
    },
  ) {}

  startAll(): void {
    for (const [name, runtime] of this.runtimes) {
      try {
        runtime.start();
      } catch (error) {
        console.warn(
          `${name} channel startup: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    void this.externalRuntime?.startAll();
  }

  reload(names: string[]): void {
    const selected = new Set(names.filter((name) => this.runtimes.has(name)));
    for (const name of selected) {
      try {
        this.runtimes.get(name)?.stop();
      } catch (error) {
        console.warn(
          `${name} channel shutdown: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const name of selected) {
      try {
        this.runtimes.get(name)?.start();
      } catch (error) {
        console.warn(
          `${name} channel startup: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    void this.externalRuntime?.reload(names);
  }

  stopAll(): void {
    for (const [name, runtime] of this.runtimes) {
      try {
        runtime.stop();
      } catch (error) {
        console.warn(
          `${name} channel shutdown: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    void this.externalRuntime?.stopAll();
  }
}

export function channelManifest(
  manifest: Omit<ChannelPluginManifest, "api_version">,
): ChannelPluginManifest {
  return { api_version: MIKI_CHANNEL_PLUGIN_API_VERSION, ...manifest };
}

export type ChannelPluginRuntimeStatus = ChannelRuntimeStatus;
