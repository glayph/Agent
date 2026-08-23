import { settings } from "@miki/config";
import {
  createProjectWorkflow,
  type ProjectTargetType,
} from "../project-workflow.js";
import type { AgentOrchestrator } from "../../agent.js";
import type { BrowserTool } from "../browser.js";
import type { ComputerAgent } from "../computer.js";
import type { CrawlerAgent } from "../crawler.js";
import type { ShellExecutor } from "../executor/shell.js";
import type { FileSecurityExecutor } from "../executor/file-security.js";
import type { RuntimeFetcher } from "../../runtime-fetch/index.js";
import type { RuntimePaths } from "../../paths.js";
import type { ApprovalInbox } from "../../security/approval-inbox.js";
import type { LauncherAdminController } from "../../api/launcher-compat.js";
import { loadWebSearchConfig, searchWeb } from "../../web-search-service.js";
import type {
  CompleteConnectionInput,
  PlatformProvider,
  SqlitePlatformConnectionStore,
} from "../../platform-connections.js";

export type ToolHandler = (
  args: Record<string, unknown>,
) => string | Promise<string>;

export interface ToolHandlerContext {
  workspaceDir: string;
  runtimePaths: RuntimePaths;
  approvalInbox?: ApprovalInbox;
  adminController?: LauncherAdminController;
  executor: ShellExecutor;
  fileOps: FileSecurityExecutor;
  browser: BrowserTool;
  computer: ComputerAgent;
  crawler: CrawlerAgent;
  orchestrator?: AgentOrchestrator | null;
  runtimeFetcher?: RuntimeFetcher | null;
  platformConnectionStore?: SqlitePlatformConnectionStore | null;
}

// Shell Handlers
export async function handleShellExecute(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const cmd = typeof args["cmd"] === "string" ? args["cmd"] : "";
  const workingDir =
    typeof args["working_dir"] === "string" ? args["working_dir"] : undefined;
  const timeout = (args["timeout"] as number) ?? 30;
  const res = await this.executor.runShell(cmd, workingDir, timeout);
  if (res.error) return `Execution Error: ${res.error}`;
  let out = "";
  if (res.stdout) out += res.stdout;
  if (res.stderr) out += `\nStderr:\n${res.stderr}`;
  if (!out) out = `(Process exited with code ${res.exitCode} and no output)`;
  return out;
}

// File Handlers
function requireFileOperationSuccess(
  toolName: "file_read" | "file_write" | "file_delete",
  output: string,
): string {
  if (output.trimStart().startsWith("Error:")) {
    throw new Error(
      `${toolName} failed: ${output.slice(output.indexOf("Error:") + 6).trim()}`,
    );
  }
  return output;
}

export async function handleFileRead(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const path = (args["path"] as string) || "";
  return requireFileOperationSuccess("file_read", this.fileOps.readFile(path));
}

export async function handleFileWrite(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const path = (args["path"] as string) || "";
  const output = this.fileOps.writeFile(
    path,
    (args["content"] as string) || "",
  );
  return requireFileOperationSuccess("file_write", output);
}

export async function handleFileDelete(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const path = (args["path"] as string) || "";
  const output = this.fileOps.deleteFile(path, args["dryRun"] === true);
  return requireFileOperationSuccess("file_delete", output);
}

// Browser Handlers
export async function handleBrowserNavigate(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.browser.navigate((args["url"] as string) || "");
}

// Browser-first platform connection handlers. These handlers deliberately do
// not accept raw tokens, API keys, passwords, or OTPs. Provider login remains
// on the official site, while Miki stores only an opaque connection reference.
function requirePlatformConnectionStore(
  context: ToolHandlerContext,
): SqlitePlatformConnectionStore {
  if (!context.platformConnectionStore) {
    throw new Error("Platform connection service is not available");
  }
  return context.platformConnectionStore;
}

export async function handlePlatformConnectionStart(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const provider = typeof args["provider"] === "string" ? args["provider"] : "";
  const store = requirePlatformConnectionStore(this);
  const scopes = Array.isArray(args["scopes"])
    ? args["scopes"].filter(
        (value): value is string => typeof value === "string",
      )
    : undefined;
  const session = store.begin({
    provider: provider as PlatformProvider,
    scopes,
  });
  let browserStatus = "official page opened";
  try {
    await this.browser.navigate(session.officialUrl);
    store.markBrowserOpened(session.id);
  } catch (error: unknown) {
    browserStatus = `browser handoff requires user action: ${error instanceof Error ? error.message : String(error)}`;
  }
  return JSON.stringify({
    action: "platform_connection_started",
    sessionId: session.id,
    provider: session.provider,
    officialUrl: session.officialUrl,
    expectedDomain: session.expectedDomain,
    expiresAt: session.expiresAt,
    browserStatus,
    userAction: session.userActionRequired,
  });
}

export async function handlePlatformConnectionStatus(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const sessionId =
    typeof args["sessionId"] === "string" ? args["sessionId"] : "";
  if (!sessionId) throw new Error("sessionId is required");
  const session = requirePlatformConnectionStore(this).getSession(sessionId);
  if (!session) throw new Error("Browser connection session not found");
  return JSON.stringify({ session });
}

export async function handlePlatformConnectionComplete(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const sessionId =
    typeof args["sessionId"] === "string" ? args["sessionId"] : "";
  const accountLabel =
    typeof args["accountLabel"] === "string" ? args["accountLabel"] : "";
  if (!sessionId || !accountLabel.trim()) {
    throw new Error("sessionId and accountLabel are required");
  }
  for (const key of [
    "token",
    "apiKey",
    "api_key",
    "secret",
    "password",
    "accessToken",
    "refreshToken",
  ]) {
    if (typeof args[key] === "string" && String(args[key]).trim()) {
      throw new Error(
        "Raw credentials are never accepted by Chat tools. Complete login in the official browser page.",
      );
    }
  }
  const input: CompleteConnectionInput = {
    accountLabel,
    externalAccountId:
      typeof args["externalAccountId"] === "string"
        ? args["externalAccountId"]
        : undefined,
    scopes: Array.isArray(args["scopes"])
      ? args["scopes"].filter(
          (value): value is string => typeof value === "string",
        )
      : undefined,
    credentialRef:
      typeof args["credentialRef"] === "string"
        ? args["credentialRef"]
        : undefined,
    expiresAt:
      typeof args["expiresAt"] === "string" ? args["expiresAt"] : undefined,
  };
  const result = requirePlatformConnectionStore(this).complete(
    sessionId,
    input,
  );
  return JSON.stringify({ action: "platform_connection_recorded", ...result });
}

export async function handlePlatformConnectionValidate(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const connectionId =
    typeof args["connectionId"] === "string" ? args["connectionId"] : "";
  if (!connectionId) throw new Error("connectionId is required");
  return JSON.stringify({
    connection: requirePlatformConnectionStore(this).validate(connectionId),
  });
}

export async function handlePlatformConnectionRevoke(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const connectionId =
    typeof args["connectionId"] === "string" ? args["connectionId"] : "";
  if (!connectionId) throw new Error("connectionId is required");
  return JSON.stringify({
    connection: requirePlatformConnectionStore(this).revoke(connectionId),
  });
}

export async function handleBrowserClick(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.browser.click((args["selector"] as string) || "");
}

export async function handleBrowserType(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.browser.type(
    (args["selector"] as string) || "",
    (args["text"] as string) || "",
    (args["enter"] as boolean) ?? false,
  );
}

function browserSemanticTargetFromArgs(args: Record<string, unknown>) {
  const target = {
    selector: args["selector"] as string | undefined,
    role: args["role"] as string | undefined,
    name: args["name"] as string | undefined,
    label: args["label"] as string | undefined,
    placeholder: args["placeholder"] as string | undefined,
    text: args["text"] as string | undefined,
    exact: args["exact"] as boolean | undefined,
  };
  const hasTarget = Object.entries(target).some(
    ([key, value]) => key !== "exact" && typeof value === "string" && value,
  );
  return hasTarget ? target : undefined;
}

export async function handleBrowserInvoke(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.browser.invoke(browserSemanticTargetFromArgs(args) || {});
}

export async function handleBrowserFill(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.browser.fill(
    browserSemanticTargetFromArgs(args) || {},
    (args["value"] as string) ?? (args["input"] as string) ?? "",
    (args["enter"] as boolean) ?? false,
  );
}

export async function handleBrowserPress(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.browser.press(
    browserSemanticTargetFromArgs(args),
    (args["key"] as string) || "Enter",
  );
}

export async function handleBrowserExtract(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.browser.extract(args["selector"] as string | undefined);
}

export async function handleBrowserScreenshot(
  this: ToolHandlerContext,
  _args: Record<string, unknown>,
): Promise<string> {
  return await this.browser.screenshot();
}

export async function handleBrowserScroll(
  this: ToolHandlerContext,
  _args: Record<string, unknown>,
): Promise<string> {
  return await this.browser.scrollDown();
}

export async function handleBrowserClose(
  this: ToolHandlerContext,
  _args: Record<string, unknown>,
): Promise<string> {
  return await this.browser.close();
}

// Mouse-free computer-use handlers
export async function handleComputerObserve(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.observe(args);
}

export async function handleComputerFocus(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.focus(args);
}

export async function handleComputerInvoke(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.invoke(args);
}

export async function handleComputerSetText(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.setText(args);
}

export async function handleComputerHotkey(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.hotkey(args);
}

export async function handleComputerClipboard(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.clipboard(args);
}

export async function handleComputerLaunch(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.launch(args);
}

export async function handleComputerVerify(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.verify(args);
}

export async function handleComputerScreenshot(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.screenshot(args);
}

export async function handleComputerListProcesses(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.listProcesses(args);
}

export async function handleComputerGetSystemInfo(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.getSystemInfo(args);
}

export async function handleComputerListDisplays(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.listDisplays(args);
}

export async function handleComputerClickAt(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.clickAt(args);
}

export async function handleComputerDrag(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.drag(args);
}

export async function handleComputerScroll(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.scroll(args);
}

export async function handleComputerTerminateApp(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.terminateApp(args);
}

export async function handleComputerListWindows(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.listWindows(args);
}

export async function handleComputerGridScreenshot(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.computer.screenshot({ ...args, grid: true });
}

// Scraper Handlers
export async function handleScrapePage(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.crawler.scrapePage(
    (args["url"] as string) || "",
    undefined,
    (args["as_markdown"] as boolean) ?? true,
  );
}

export async function handleScrapeSelectors(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.crawler.scrapeSelectors(
    (args["url"] as string) || "",
    (args["selectors"] as string[]) || [],
  );
}

export async function handleScrapePaginated(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.crawler.scrapePaginated(
    (args["url"] as string) || "",
    (args["next_selector"] as string) || "",
    (args["max_pages"] as number) ?? 5,
  );
}

export async function handleScrapeInfiniteScroll(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.crawler.scrapeInfiniteScroll(
    (args["url"] as string) || "",
    (args["max_scrolls"] as number) ?? 10,
  );
}

export async function handleScrapeJson(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.crawler.scrapeJson((args["url"] as string) || "");
}

export async function handleScrapeTable(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.crawler.extractTable(
    (args["selector"] as string) || "table",
  );
}

// Dual-mode Web Search Handler
export async function handleWebSearch(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const query = typeof args.query === "string" ? args.query : "";
  const config = loadWebSearchConfig(this.runtimePaths.configDir);
  try {
    const result = await searchWeb(this.runtimePaths.configDir, config, query, {
      maxResults: args.max_results,
      mode: args.mode,
      provider: args.provider,
    });
    // Keep the result structured while avoiding pretty-print whitespace in the
    // model context. Inspector events still retain the complete output.
    return JSON.stringify(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Web search failed: ${message.slice(0, 240)}`;
  }
}

// Direct Download Search Handler
const FILE_TYPE_EXTENSIONS: Record<string, string> = {
  video: "mkv|mp4|avi|mov|mpg|wmv|divx|mpeg",
  audio: "mp3|wav|ac3|ogg|flac|wma|m4a|aac|mod",
  ebook:
    "MOBI|CBZ|CBR|CBC|CHM|EPUB|FB2|LIT|LRF|ODT|PDF|PRC|PDB|PML|RB|RTF|TCR|DOC|DOCX",
  software: "exe|iso|dmg|tar|7z|bz2|gz|rar|zip|apk",
  image: "jpg|png|bmp|gif|tif|tiff|psd",
};

const SEARCH_ENGINES: Record<string, string> = {
  google: "https://www.google.com/search?q=",
  startpage: "https://www.startpage.com/do/dsearch?query=",
  searx: "https://searx.me/?q=",
  filepursuit: "https://filepursuit.com/search/",
};

const FILEPURSUIT_FILE_TYPE_MAP: Record<string, string> = {
  video: "video",
  audio: "audio",
  ebook: "ebook",
  software: "archive",
  image: "picture",
  all: "all",
};

export async function handleDirectDownloadSearch(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const query = (args["query"] as string) || "";
  const fileType = (args["fileType"] as string) || "all";
  const engine = (args["engine"] as string) || "google";

  if (!query.trim()) {
    return "Error: query parameter is required";
  }

  if (engine === "filepursuit") {
    const fpFileType = FILEPURSUIT_FILE_TYPE_MAP[fileType] || "all";
    const encodedQuery = query.replace(/ /g, "+");
    return `https://filepursuit.com/search/${encodedQuery}/${fpFileType}`;
  }

  const extensions = FILE_TYPE_EXTENSIONS[fileType];
  const engineBase = SEARCH_ENGINES[engine] || SEARCH_ENGINES["google"];

  let finalQuery: string;
  if (fileType !== "all" && extensions) {
    finalQuery = `${query} +(${extensions}) -inurl:(jsp|pl|php|html|aspx|htm|cf|shtml) intitle:index.of -inurl:(listen77|mp3raid|mp3toss|mp3drug|index_of|index-of|wallywashis|downloadmana)`;
  } else {
    finalQuery = `${query} -inurl:(jsp|pl|php|html|aspx|htm|cf|shtml) intitle:index.of -inurl:(listen77|mp3raid|mp3toss|mp3drug|index_of|index-of|wallywashis|downloadmana)`;
  }

  return `${engineBase}${encodeURIComponent(finalQuery)}`;
}

// System index handlers are disabled.
export async function handleSystemIndexSearch(
  this: ToolHandlerContext,
  _args: Record<string, unknown>,
): Promise<string> {
  return "System index search is disabled.";
}
// Project Workflow Handler
export async function handleProjectWorkflowCreate(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const workflow = createProjectWorkflow(this.workspaceDir, {
      brief: (args["brief"] as string) || "",
      projectName: args["project_name"] as string | undefined,
      targetType: args["target_type"] as ProjectTargetType | undefined,
      constraints: args["constraints"] as string[] | string | undefined,
      writeFiles: args["write_files"] as boolean | undefined,
      scaffoldFiles: args["scaffold_files"] as boolean | undefined,
      overwrite: args["overwrite"] as boolean | undefined,
      runGates: args["run_gates"] as boolean | undefined,
      gateNames: args["gate_names"] as string[] | string | undefined,
      gateTimeoutMs: args["gate_timeout_ms"] as number | undefined,
      outputDir: args["output_dir"] as string | undefined,
    });
    return JSON.stringify(workflow, null, 2);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Goal pursuit handlers are disabled without memory persistence.
export async function handleGoalCreate(
  this: ToolHandlerContext,
  _args: Record<string, unknown>,
): Promise<string> {
  return "Goal management is disabled in this build.";
}

export async function handleGoalStatus(
  this: ToolHandlerContext,
  _args: Record<string, unknown>,
): Promise<string> {
  return JSON.stringify({
    active: null,
    goals: [],
    summary: { hasActiveGoal: false },
  });
}

export async function handleGoalUpdate(
  this: ToolHandlerContext,
  _args: Record<string, unknown>,
): Promise<string> {
  return "Goal management is disabled in this build.";
}

// Model handlers are disabled without memory persistence.
export async function handleModelList(
  this: ToolHandlerContext,
): Promise<string> {
  const supportedModels = settings.getSupportedModels();
  return JSON.stringify({
    available: supportedModels,
    provider_models: [],
    active_model: settings.defaultModel,
    provider: settings.provider,
  });
}

export async function handleModelAdd(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const modelName = args["model_name"] as string;
  if (!modelName) return "Error: model_name is required";
  return JSON.stringify({ success: true, model: modelName });
}

export async function handleModelDelete(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const modelName = args["model_name"] as string;
  if (!modelName) return "Error: model_name is required";
  return JSON.stringify({ success: true, model: modelName });
}

export async function handleModelSelect(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const modelName = args["model_name"] as string;
  if (!modelName) return "Error: model_name is required";
  const isSupported = settings.getSupportedModels().includes(modelName);
  if (!isSupported) {
    return `Model '${modelName}' is not available.`;
  }
  settings.setModel(modelName);
  if (this.orchestrator) {
    this.orchestrator.modelName = modelName;
    this.orchestrator.provider = settings.provider;
  }
  return JSON.stringify({ success: true, active_model: modelName });
}

// Runtime Fetcher Handlers
export async function handleRuntimeEnsure(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!this.runtimeFetcher) {
    return JSON.stringify({
      outcome: "failed",
      error: "Runtime fetcher is not initialized on this agent instance.",
    });
  }
  const skillId = args["skill_id"] as string;
  const language = args["language"] as string;
  const packages = Array.isArray(args["packages"])
    ? (args["packages"] as unknown[]).filter(
        (p): p is string => typeof p === "string",
      )
    : [];
  const version = args["version"] as string | undefined;

  if (!skillId || !language) {
    return JSON.stringify({
      outcome: "failed",
      error: "skill_id and language are required.",
    });
  }

  const result = await this.runtimeFetcher.ensureRuntimeReady(skillId, {
    language,
    packages,
    version,
  });
  return JSON.stringify(result);
}

export async function handleRuntimeEnsureStatus(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!this.runtimeFetcher) {
    return JSON.stringify({
      error: "Runtime fetcher is not initialized on this agent instance.",
    });
  }
  const requestId = args["request_id"] as string | undefined;
  const store = this.runtimeFetcher.getConsentStore();

  if (requestId) {
    const request = store.getById(requestId);
    if (!request) {
      return JSON.stringify({ error: `No such request: ${requestId}` });
    }
    return JSON.stringify(request);
  }

  return JSON.stringify({ pending: store.listPending() });
}
