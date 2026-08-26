import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { ToolRegistrySchemas, ToolDefinition, ToolHandler } from "./schemas.js";
import {
  handleShellExecute,
  handleFileRead,
  handleFileWrite,
  handleFileDelete,
  handleBrowserNavigate,
  handleBrowserClick,
  handleBrowserType,
  handleBrowserInvoke,
  handleBrowserFill,
  handleBrowserPress,
  handleBrowserExtract,
  handleBrowserScreenshot,
  handleBrowserScroll,
  handleBrowserClose,
  handlePlatformConnectionStart,
  handlePlatformConnectionStatus,
  handlePlatformConnectionComplete,
  handlePlatformConnectionValidate,
  handlePlatformConnectionRevoke,
  handleComputerObserve,
  handleComputerFocus,
  handleComputerInvoke,
  handleComputerSetText,
  handleComputerHotkey,
  handleComputerClipboard,
  handleComputerLaunch,
  handleComputerVerify,
  handleComputerScreenshot,
  handleComputerListProcesses,
  handleComputerGetSystemInfo,
  handleComputerListDisplays,
  handleComputerClickAt,
  handleComputerDrag,
  handleComputerScroll,
  handleComputerTerminateApp,
  handleComputerListWindows,
  handleComputerGridScreenshot,
  handleScrapePage,
  handleScrapeSelectors,
  handleScrapePaginated,
  handleScrapeInfiniteScroll,
  handleScrapeJson,
  handleScrapeTable,
  handleModelList,
  handleModelAdd,
  handleModelDelete,
  handleModelSelect,
  handleDirectDownloadSearch,
  handleWebSearch,
  handleProjectWorkflowCreate,
  handleRuntimeEnsure,
  handleRuntimeEnsureStatus,
} from "./handlers.js";
import { ShellExecutor } from "../executor/shell.js";
import { FileSecurityExecutor } from "../executor/file-security.js";
import { ProfileManager } from "../profile-manager.js";
import { BrowserTool, BrowserConfig } from "../browser.js";
import { ComputerAgent } from "../computer.js";
import { CrawlerAgent } from "../crawler.js";
import type { AgentOrchestrator } from "../../agent.js";
import { getErrorMessage } from "../../errors.js";
import { normalizeRuntimePaths, type RuntimePaths } from "../../paths.js";
import { RuntimeFetcher } from "../../runtime-fetch/index.js";
import type { SqlitePlatformConnectionStore } from "../../platform-connections.js";
import type { ApprovalInbox } from "../../security/approval-inbox.js";
import type { LauncherAdminController } from "../../api/launcher-compat.js";
import {
  handleSkillSearch,
  handleSkillCreate,
  handleSkillInstall,
} from "./admin-skill-handlers.js";
import {
  handleAdminConfigGet,
  handleAdminConfigValidate,
  handleAdminConfigPatch,
  handleAdminToolState,
} from "./admin-control-handlers.js";

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  executionTimeMs?: number;
}

const DEFAULT_TOOL_TIMEOUT = 60_000;
const TOOL_TIMEOUTS: Record<string, number> = {
  shell_execute: 120_000,
  browser_navigate: 120_000,
  computer_observe: 45_000,
  computer_launch: 45_000,
  scrape_page: 120_000,
  scrape_paginated: 60_000,
  scrape_infinite_scroll: 120_000,
};

interface RuntimeToolsConfig {
  permissions?: Record<
    string,
    {
      level?: string;
      allow_app_launch?: boolean;
      allowed_languages?: string[];
      allow_sudo?: boolean;
    }
  >;
  tool_state?: Record<string, boolean>;
  disabled_tools?: string[];
}

export interface ToolExecutionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function executeWithTimeout<T>(
  fn: () => Promise<T>,
  timeout: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Tool execution cancelled"));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const onAbort = () => {
      settle(() => reject(new Error("Tool execution cancelled")));
    };

    timeoutId = setTimeout(() => {
      settle(() => reject(new Error(`Tool timed out after ${timeout}ms`)));
    }, timeout);

    signal?.addEventListener("abort", onAbort, { once: true });

    fn()
      .then((value) => settle(() => resolve(value)))
      .catch((error) => settle(() => reject(error)));
  });
}

export class ToolRegistry {
  public executor: ShellExecutor;
  public runtimePaths: RuntimePaths;
  public workspaceDir: string;
  public browser: BrowserTool;
  public computer: ComputerAgent;
  public crawler: CrawlerAgent;
  public profileManager: ProfileManager | null = null;
  public orchestrator: AgentOrchestrator | null = null;
  public runtimeFetcher: RuntimeFetcher | null = null;
  public platformConnectionStore: SqlitePlatformConnectionStore | null = null;
  public approvalInbox: ApprovalInbox | undefined;
  public adminController: LauncherAdminController | undefined;
  private handlers: Map<string, ToolHandler> = new Map();
  private skillToolDefs: Map<string, ToolDefinition> = new Map();
  private pluginToolDefs: Map<string, ToolDefinition> = new Map();

  public fileOps: FileSecurityExecutor;

  constructor(
    paths: RuntimePaths | string,
    configPath?: string,
    browserConfig?: BrowserConfig,
  ) {
    const runtimePaths = normalizeRuntimePaths(paths);
    this.executor = new ShellExecutor(
      configPath || path.join(runtimePaths.configDir, "tools.yaml"),
    );
    this.fileOps = new FileSecurityExecutor(
      configPath || path.join(runtimePaths.configDir, "tools.yaml"),
    );

    this.runtimePaths = runtimePaths;
    this.workspaceDir = path.resolve(
      runtimePaths.sourceDir ?? runtimePaths.dataDir,
    );
    this.executor.setWorkspaceRoot(this.workspaceDir);
    this.fileOps.setWorkspaceRoot(this.workspaceDir);

    this.browser = new BrowserTool(
      false,
      runtimePaths.dataDir,
      undefined,
      browserConfig,
    );
    this.computer = new ComputerAgent();
    this.crawler = new CrawlerAgent(this.browser);
    this.initRuntimeFetcher();
    this.registerBuiltins();
  }

  private initRuntimeFetcher(): void {
    try {
      const config = this.loadRuntimeToolsConfig();
      const runtimeInstallerConfig = config.permissions?.runtime_installer;
      const level = String(
        runtimeInstallerConfig?.level || "REQUIRE_APPROVAL",
      ).toUpperCase();
      const approvalLevel:
        "REQUIRE_APPROVAL" | "TRUSTED_FULL_ACCESS" | "DISABLED" =
        this.isDisabledLevel(level)
          ? "DISABLED"
          : level === "TRUSTED_FULL_ACCESS"
            ? "TRUSTED_FULL_ACCESS"
            : "REQUIRE_APPROVAL";

      this.runtimeFetcher = new RuntimeFetcher({
        dataDir: this.runtimePaths.dataDir,
        shell: this.executor,
        allowedLanguages: runtimeInstallerConfig?.allowed_languages,
        approvalLevel,
      });
    } catch (err) {
      console.warn("Failed to initialize runtime fetcher:", err);
      this.runtimeFetcher = null;
    }
  }

  setOrchestrator(orchestrator: AgentOrchestrator): void {
    this.orchestrator = orchestrator;
  }

  /**
   * Update the workspace used by workspace-aware built-in tools without
   * rebuilding the registry. The path is normalized here so callers cannot
   * accidentally create divergent relative-path behavior after a config
   * reload.
   */
  setWorkspaceDir(workspaceDir: string): void {
    const trimmed = workspaceDir.trim();
    if (!trimmed) return;
    this.workspaceDir = path.resolve(trimmed);
    this.executor.setWorkspaceRoot(this.workspaceDir);
    this.fileOps.setWorkspaceRoot(this.workspaceDir);
  }

  setPlatformConnectionStore(store: SqlitePlatformConnectionStore): void {
    this.platformConnectionStore = store;
  }

  setApprovalInbox(inbox: ApprovalInbox): void {
    this.approvalInbox = inbox;
  }

  setAdminController(controller: LauncherAdminController): void {
    this.adminController = controller;
  }

  registerHandler(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  hasTool(name: string): boolean {
    return this.handlers.has(name);
  }

  registerSkillTool(
    name: string,
    handler: ToolHandler,
    definition: ToolDefinition,
  ): void {
    this.handlers.set(name, handler);
    this.skillToolDefs.set(name, definition);
  }

  unregisterSkillTool(name: string): void {
    this.handlers.delete(name);
    this.skillToolDefs.delete(name);
  }

  registerPluginTool(
    name: string,
    handler: ToolHandler,
    definition: ToolDefinition,
  ): void {
    this.handlers.set(name, handler);
    this.pluginToolDefs.set(name, definition);
  }

  unregisterPluginTool(name: string): void {
    this.handlers.delete(name);
    this.pluginToolDefs.delete(name);
  }

  clearPluginTools(): void {
    for (const name of this.pluginToolDefs.keys()) {
      this.handlers.delete(name);
    }
    this.pluginToolDefs.clear();
  }

  private loadRuntimeToolsConfig(): RuntimeToolsConfig {
    const configPath = this.executor?.configPath;
    if (!configPath || !fs.existsSync(configPath)) return {};
    try {
      return (yaml.load(fs.readFileSync(configPath, "utf-8")) ||
        {}) as RuntimeToolsConfig;
    } catch {
      return {};
    }
  }

  private isDisabledLevel(level?: string): boolean {
    return ["DISABLED", "OFF", "DENY", "DENIED", "BLOCKED"].includes(
      String(level || "").toUpperCase(),
    );
  }

  private permissionNameForTool(name: string): string | undefined {
    if (
      name === "shell_execute" ||
      name === "file_read" ||
      name === "file_write" ||
      name === "file_delete"
    ) {
      return name;
    }
    if (name.startsWith("computer_")) return "computer_use";
    if (name === "runtime_ensure" || name === "runtime_ensure_status") {
      return "runtime_installer";
    }
    return undefined;
  }

  private disabledReason(name: string): string | null {
    const config = this.loadRuntimeToolsConfig();
    if (config.tool_state?.[name] === false) {
      return `Tool '${name}' is disabled by config/tools.yaml.`;
    }
    if (config.disabled_tools?.includes(name)) {
      return `Tool '${name}' is disabled by config/tools.yaml.`;
    }
    if (
      name === "computer_launch" &&
      config.permissions?.computer_use?.allow_app_launch === false
    ) {
      return "Tool 'computer_launch' is disabled by config/tools.yaml computer_use.allow_app_launch=false.";
    }
    const permissionName = this.permissionNameForTool(name);
    if (
      permissionName &&
      this.isDisabledLevel(config.permissions?.[permissionName]?.level)
    ) {
      return `Tool '${name}' is disabled by config/tools.yaml.`;
    }
    return null;
  }

  getSkillToolNames(): string[] {
    return Array.from(this.skillToolDefs.keys());
  }

  getPluginToolNames(): string[] {
    return Array.from(this.pluginToolDefs.keys());
  }

  private registerBuiltins(): void {
    this.registerHandler("shell_execute", handleShellExecute.bind(this));
    this.registerHandler("file_read", handleFileRead.bind(this));
    this.registerHandler("file_write", handleFileWrite.bind(this));
    this.registerHandler("file_delete", handleFileDelete.bind(this));
    this.registerHandler("browser_navigate", handleBrowserNavigate.bind(this));
    this.registerHandler("browser_click", handleBrowserClick.bind(this));
    this.registerHandler("browser_type", handleBrowserType.bind(this));
    this.registerHandler("browser_invoke", handleBrowserInvoke.bind(this));
    this.registerHandler("browser_fill", handleBrowserFill.bind(this));
    this.registerHandler("browser_press", handleBrowserPress.bind(this));
    this.registerHandler("browser_extract", handleBrowserExtract.bind(this));
    this.registerHandler(
      "browser_screenshot",
      handleBrowserScreenshot.bind(this),
    );
    this.registerHandler("browser_scroll", handleBrowserScroll.bind(this));
    this.registerHandler("browser_close", handleBrowserClose.bind(this));
    this.registerHandler(
      "platform_connection_start",
      handlePlatformConnectionStart.bind(this),
    );
    this.registerHandler(
      "platform_connection_status",
      handlePlatformConnectionStatus.bind(this),
    );
    this.registerHandler(
      "platform_connection_complete",
      handlePlatformConnectionComplete.bind(this),
    );
    this.registerHandler(
      "platform_connection_validate",
      handlePlatformConnectionValidate.bind(this),
    );
    this.registerHandler(
      "platform_connection_revoke",
      handlePlatformConnectionRevoke.bind(this),
    );
    this.registerHandler("computer_observe", handleComputerObserve.bind(this));
    this.registerHandler("computer_focus", handleComputerFocus.bind(this));
    this.registerHandler("computer_invoke", handleComputerInvoke.bind(this));
    this.registerHandler("computer_set_text", handleComputerSetText.bind(this));
    this.registerHandler("computer_hotkey", handleComputerHotkey.bind(this));
    this.registerHandler(
      "computer_clipboard",
      handleComputerClipboard.bind(this),
    );
    this.registerHandler("computer_launch", handleComputerLaunch.bind(this));
    this.registerHandler("computer_verify", handleComputerVerify.bind(this));
    this.registerHandler(
      "computer_screenshot",
      handleComputerScreenshot.bind(this),
    );
    this.registerHandler(
      "computer_list_processes",
      handleComputerListProcesses.bind(this),
    );
    this.registerHandler(
      "computer_get_system_info",
      handleComputerGetSystemInfo.bind(this),
    );
    this.registerHandler(
      "computer_list_displays",
      handleComputerListDisplays.bind(this),
    );
    this.registerHandler("computer_click_at", handleComputerClickAt.bind(this));
    this.registerHandler("computer_drag", handleComputerDrag.bind(this));
    this.registerHandler("computer_scroll", handleComputerScroll.bind(this));
    this.registerHandler(
      "computer_terminate_app",
      handleComputerTerminateApp.bind(this),
    );
    this.registerHandler(
      "computer_list_windows",
      handleComputerListWindows.bind(this),
    );
    this.registerHandler(
      "computer_grid_screenshot",
      handleComputerGridScreenshot.bind(this),
    );
    this.registerHandler("scrape_page", handleScrapePage.bind(this));
    this.registerHandler("scrape_selectors", handleScrapeSelectors.bind(this));
    this.registerHandler("scrape_paginated", handleScrapePaginated.bind(this));
    this.registerHandler(
      "scrape_infinite_scroll",
      handleScrapeInfiniteScroll.bind(this),
    );
    this.registerHandler("scrape_json", handleScrapeJson.bind(this));
    this.registerHandler("scrape_table", handleScrapeTable.bind(this));
    this.registerHandler("model_list", handleModelList.bind(this));
    this.registerHandler("model_add", handleModelAdd.bind(this));
    this.registerHandler("model_delete", handleModelDelete.bind(this));
    this.registerHandler("model_select", handleModelSelect.bind(this));
    this.registerHandler(
      "direct_download_search",
      handleDirectDownloadSearch.bind(this),
    );
    this.registerHandler("web_search", handleWebSearch.bind(this));
    this.registerHandler(
      "project_workflow_create",
      handleProjectWorkflowCreate.bind(this),
    );
    this.registerHandler("runtime_ensure", handleRuntimeEnsure.bind(this));
    this.registerHandler(
      "runtime_ensure_status",
      handleRuntimeEnsureStatus.bind(this),
    );
    this.registerHandler("skill_search", handleSkillSearch.bind(this));
    this.registerHandler("skill_create", handleSkillCreate.bind(this));
    this.registerHandler("skill_install", handleSkillInstall.bind(this));
    this.registerHandler("admin_config_get", handleAdminConfigGet.bind(this));
    this.registerHandler(
      "admin_config_validate",
      handleAdminConfigValidate.bind(this),
    );
    this.registerHandler(
      "admin_config_patch",
      handleAdminConfigPatch.bind(this),
    );
    this.registerHandler("admin_tool_state", handleAdminToolState.bind(this));
  }

  getToolDefinitions(): ToolDefinition[] {
    const builtins = [
      ...ToolRegistrySchemas.shellSchema(),
      ...ToolRegistrySchemas.fileSchemas(),
      ...ToolRegistrySchemas.browserSchemas(),
      ...ToolRegistrySchemas.platformConnectionSchemas(),
      ...ToolRegistrySchemas.computerSchemas(),
      ...ToolRegistrySchemas.scraperSchemas(),
      ...ToolRegistrySchemas.modelSchemas(),
      ...ToolRegistrySchemas.directDownloadSchema(),
      ...ToolRegistrySchemas.webSearchSchema(),
      ...ToolRegistrySchemas.projectWorkflowSchemas(),
      ...ToolRegistrySchemas.runtimeSchema(),
      ...ToolRegistrySchemas.skillSchemas(),
      ...ToolRegistrySchemas.adminSchemas(),
    ];
    const skillTools = Array.from(this.skillToolDefs.values());
    const pluginTools = Array.from(this.pluginToolDefs.values());
    return [...builtins, ...skillTools, ...pluginTools].map((definition) => ({
      ...definition,
      risk: definition.risk || riskForTool(definition.function.name),
    }));
  }

  private async runHandler(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`Tool '${name}' not found in registry`);
    }
    const result = handler(args);
    if (result instanceof Promise) return await result;
    return result;
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    options: ToolExecutionOptions = {},
  ): Promise<string> {
    try {
      const disabled = this.disabledReason(name);
      if (disabled) throw new Error(disabled);
      const timeout =
        options.timeoutMs ?? TOOL_TIMEOUTS[name] ?? DEFAULT_TOOL_TIMEOUT;
      const output = await executeWithTimeout(
        () => this.runHandler(name, args),
        timeout,
        options.signal,
      );
      return output;
    } catch (e: unknown) {
      return `Error executing tool '${name}': ${getErrorMessage(e)}`;
    }
  }

  async executeToolStructured(
    name: string,
    args: Record<string, unknown>,
    options: ToolExecutionOptions = {},
  ): Promise<ToolResult> {
    const startMs = Date.now();
    try {
      const disabled = this.disabledReason(name);
      if (disabled) throw new Error(disabled);
      const timeout =
        options.timeoutMs ?? TOOL_TIMEOUTS[name] ?? DEFAULT_TOOL_TIMEOUT;
      const output = await executeWithTimeout(
        () => this.runHandler(name, args),
        timeout,
        options.signal,
      );
      return { success: true, output, executionTimeMs: Date.now() - startMs };
    } catch (e: unknown) {
      return {
        success: false,
        output: "",
        error: getErrorMessage(e),
        executionTimeMs: Date.now() - startMs,
      };
    }
  }
}

export { ToolRegistrySchemas } from "./schemas.js";

function riskForTool(toolName: string): ToolDefinition["risk"] {
  if (
    toolName === "shell_execute" ||
    toolName === "file_write" ||
    toolName === "file_delete" ||
    toolName.startsWith("computer_")
  ) {
    return {
      level: "high",
      label: "High risk",
      reason:
        "Can mutate local files, execute commands, or control the desktop.",
    };
  }
  if (
    toolName.startsWith("browser_") ||
    toolName.startsWith("scrape_") ||
    toolName.startsWith("model_")
  ) {
    return {
      level: "medium",
      label: "Medium risk",
      reason: "Can access network, external services, or provider state.",
    };
  }
  return {
    level: "low",
    label: "Low risk",
    reason: "Read-only or workflow metadata operation.",
  };
}
