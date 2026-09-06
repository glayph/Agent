import {
  pluginManifest,
  type ManagedPlugin,
  type PluginContext,
  type PluginDescriptor,
  type PluginHealth,
  type PluginManifest,
} from "./index.js";

export interface InjectedServiceRuntime<T> extends ManagedPlugin {
  readonly service?: T;
}

export function createInjectedServicePlugin<T>(options: {
  manifest: Omit<PluginManifest, "apiVersion">;
  serviceId: string;
}): PluginDescriptor<Record<string, never>, InjectedServiceRuntime<T>> {
  return {
    manifest: pluginManifest(options.manifest),
    create(context: PluginContext): InjectedServiceRuntime<T> {
      const service = context.getService?.<T>(options.serviceId);
      return {
        service,
        health(): PluginHealth {
          return service
            ? {
                ok: true,
                status: "functional",
                details: { serviceId: options.serviceId },
              }
            : {
                ok: false,
                status: "partial",
                message: `Core service '${options.serviceId}' was not injected.`,
              };
        },
      };
    },
  };
}
