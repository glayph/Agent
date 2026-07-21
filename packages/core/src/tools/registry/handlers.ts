import { settings } from "@hiro/config";
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

export type ToolHandler = (
  args: Record<string, unknown>,
) => string | Promise<string>;

interface ToolHandlerContext {
  workspaceDir: string;
  executor: ShellExecutor;
  fileOps: FileSecurityExecutor;
  browser: BrowserTool;
  computer: ComputerAgent;
  crawler: CrawlerAgent;
  orchestrator?: AgentOrchestrator | null;
}

// Shell Handlers
export async function handleShellExecute(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const cmd = args["cmd"] as string;
  const workingDir = args["working_dir"] as string | undefined;
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
export async function handleFileRead(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return this.fileOps.readFile((args["path"] as string) || "");
}

export async function handleFileWrite(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return this.fileOps.writeFile(
    (args["path"] as string) || "",
    (args["content"] as string) || "",
  );
}

export async function handleFileDelete(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return this.fileOps.deleteFile((args["path"] as string) || "");
}

// Browser Handlers
export async function handleBrowserNavigate(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  return await this.browser.navigate((args["url"] as string) || "");
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
