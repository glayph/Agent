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
  handleProjectWorkflowCreate,
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
  permissions?: Record<string, { level?: string; allow_app_launch?: boolean }>;
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
    this.workspaceDir = runtimePaths.sourceDir ?? runtimePaths.dataDir;

    this.browser = new BrowserTool(
      false,
      runtimePaths.dataDir,
      undefined,
      browserConfig,
    );
    this.computer = new ComputerAgent();
    this.crawler = new CrawlerAgent(this.browser);
    this.registerBuiltins();
  }

  setOrchestrator(orchestrator: AgentOrchestrator): void {
    this.orchestrator = orchestrator;
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
    this.registerHandler(
      "project_workflow_create",
      handleProjectWorkflowCreate.bind(this),
    );
  }

  getToolDefinitions(): ToolDefinition[] {
    const builtins = [
      ...ToolRegistrySchemas.shellSchema(),
      ...ToolRegistrySchemas.fileSchemas(),
      ...ToolRegistrySchemas.browserSchemas(),
      ...ToolRegistrySchemas.computerSchemas(),
      ...ToolRegistrySchemas.scraperSchemas(),
      ...ToolRegistrySchemas.modelSchemas(),
      ...ToolRegistrySchemas.directDownloadSchema(),
      ...ToolRegistrySchemas.projectWorkflowSchemas(),
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
