import { BrowserTool, type BrowserConfig } from "./runtime.js";
import {
  pluginManifest,
  type ManagedPlugin,
  type PluginContext,
  type PluginDescriptor,
  type PluginHealth,
} from "../sdk/index.js";

export interface BrowserPluginConfig extends BrowserConfig {
  headless?: boolean;
}

export interface BrowserPluginRuntime extends ManagedPlugin {
  readonly browser: BrowserTool;
}

class BrowserRuntime implements BrowserPluginRuntime {
  private readonly ownsBrowser: boolean;

  constructor(
    readonly browser: BrowserTool,
    ownsBrowser: boolean,
  ) {
    this.ownsBrowser = ownsBrowser;
  }

  health(): PluginHealth {
    return {
      ok: true,
      status: "functional",
      details: { managed: true, ownsResource: this.ownsBrowser },
    };
  }

  async stop(): Promise<void> {
    if (this.ownsBrowser) await this.browser.close();
  }
}

export const browserPlugin: PluginDescriptor<
  BrowserPluginConfig,
  BrowserPluginRuntime
> = {
  manifest: pluginManifest({
    id: "browser.playwright",
    displayName: "Browser Use",
    version: "1.0.0",
    capabilities: ["browser"],
    runtimeStatus: "functional",
    description:
      "Playwright-backed browser sessions with workspace previews and screenshots.",
    configKey: "browser",
    requiredConfig: [],
    secretFields: [],
    permissions: ["network", "filesystem-write", "browser"],
    platform: ["win32", "linux", "darwin"],
  }),

  create(
    context: PluginContext,
    config: BrowserPluginConfig = {},
  ): BrowserPluginRuntime {
    const injected = context.getService?.<BrowserTool>("browser");
    if (injected) {
      injected.setWorkspaceDir(context.workspaceDir);
      return new BrowserRuntime(injected, false);
    }
    const browser = new BrowserTool(
      config.headless ?? false,
      context.dataDir,
      undefined,
      config,
    );
    browser.setWorkspaceDir(context.workspaceDir);
    return new BrowserRuntime(browser, true);
  },
};
