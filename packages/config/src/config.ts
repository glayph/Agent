import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { validateRuntimeConfig } from "./schema.js";
import {
  isSecretEnvKey,
  resolveEnvSecret,
  setEnvSecret,
} from "./secret-vault.js";

const candidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "..", ".env"),
  path.resolve(process.cwd(), "..", "..", ".env"),
  path.resolve(process.cwd(), "..", "..", "..", ".env"),
  path.resolve(process.cwd(), "..", "..", "..", "..", ".env"),
];

const ENV_PATH = (candidates.find((p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}) || path.resolve(process.cwd(), ".env")) as string;

dotenv.config({ path: ENV_PATH });

export const BUILTIN_MODELS = [
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "openai/gpt-4o-2024-08-06",
  "anthropic/claude-3.5-sonnet",
  "google/gemini-2.0-flash-001",
  "meta-llama/llama-3.3-70b-instruct",
];

export function shouldWarnMissingApiKeys(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env["Hiro_WARN_MISSING_API_KEYS"] === "true";
}

export class Settings {
  private static _instance: Settings;
  private _modelChangeCallbacks: Array<(model: string) => void> = [];
  private _apiKeyChangeCallbacks: Array<() => void> = [];

  static getInstance(): Settings {
    if (!Settings._instance) {
      Settings._instance = new Settings();
    }
    return Settings._instance;
  }

  get openrouterApiKey(): string {
    return resolveEnvSecret("OPENROUTER_API_KEY");
  }

  get geminiApiKey(): string {
    return resolveEnvSecret("GEMINI_API_KEY");
  }

  get googleApiKey(): string {
    return resolveEnvSecret("GOOGLE_API_KEY");
  }

  get defaultModel(): string {
    return process.env["DEFAULT_MODEL"] || "google/gemini-2.0-flash-001";
  }

  get defaultTemperature(): number {
    const val = parseFloat(process.env["DEFAULT_TEMPERATURE"] || "0.7");
    if (isNaN(val) || val < 0 || val > 2) {
      console.warn(
        `Invalid DEFAULT_TEMPERATURE "${process.env["DEFAULT_TEMPERATURE"]}", using default 0.7`,
      );
      return 0.7;
    }
    return val;
  }

  get defaultMaxTokens(): number {
    const val = parseInt(process.env["DEFAULT_MAX_TOKENS"] || "4096", 10);
    if (isNaN(val) || val < 1 || val > 128000) {
      console.warn(
        `Invalid DEFAULT_MAX_TOKENS "${process.env["DEFAULT_MAX_TOKENS"]}", using default 4096`,
      );
      return 4096;
    }
    return val;
  }

  get defaultTimeout(): number {
    const val = parseInt(process.env["DEFAULT_TIMEOUT"] || "120", 10);
    if (isNaN(val) || val < 1 || val > 300) {
      console.warn(
        `Invalid DEFAULT_TIMEOUT "${process.env["DEFAULT_TIMEOUT"]}", using default 120`,
      );
      return 120;
    }
    return val;
  }

  get corePort(): number {
    const val = parseInt(process.env["CORE_PORT"] || "8000", 10);
    if (isNaN(val) || val < 1 || val > 65535) {
      console.warn(
        `Invalid CORE_PORT "${process.env["CORE_PORT"]}", using default 8000`,
      );
      return 8000;
    }
    return val;
  }

  get maxConcurrentTasks(): number {
    const val = parseInt(process.env["MAX_CONCURRENT_TASKS"] || "3", 10);
    if (isNaN(val) || val < 1) {
      console.warn(
        `Invalid MAX_CONCURRENT_TASKS "${process.env["MAX_CONCURRENT_TASKS"]}", using default 3`,
      );
      return 3;
    }
    return val;
  }

  get maxParallelToolCalls(): number {
    const fallback = String(this.maxConcurrentTasks);
    const val = parseInt(
      process.env["MAX_PARALLEL_TOOL_CALLS"] || fallback,
      10,
    );
    if (isNaN(val) || val < 1 || val > 100) {
      console.warn(
        `Invalid MAX_PARALLEL_TOOL_CALLS "${process.env["MAX_PARALLEL_TOOL_CALLS"]}", using default ${fallback}`,
      );
      return parseInt(fallback, 10);
    }
    return val;
  }

  get toolLockTimeoutMs(): number {
    const val = parseInt(process.env["TOOL_LOCK_TIMEOUT_MS"] || "30000", 10);
    if (isNaN(val) || val < 1000 || val > 300000) {
      console.warn(
        `Invalid TOOL_LOCK_TIMEOUT_MS "${process.env["TOOL_LOCK_TIMEOUT_MS"]}", using default 30000`,
      );
      return 30000;
    }
    return val;
  }

  get taskQueueSize(): number {
    const val = parseInt(process.env["TASK_QUEUE_SIZE"] || "50", 10);
    if (isNaN(val) || val < 1) {
      console.warn(
        `Invalid TASK_QUEUE_SIZE "${process.env["TASK_QUEUE_SIZE"]}", using default 50`,
      );
      return 50;
    }
    return val;
  }

  get coreHost(): string {
    return process.env["CORE_HOST"] || "127.0.0.1";
  }

  get apiKey(): string {
    return resolveEnvSecret("API_KEY");
  }

  get llmBaseUrl(): string {
    return process.env["LLM_BASE_URL"] || "https://openrouter.ai/api/v1";
  }

  get telegramBotToken(): string {
    return resolveEnvSecret("TELEGRAM_BOT_TOKEN");
  }

  get provider(): string {
    const model = this.defaultModel;
    if (model.startsWith("openrouter/")) return "openrouter";
    if (model.startsWith("gemini/") || model.startsWith("google/"))
      return "google";
    if (model.startsWith("anthropic/")) return "anthropic";
    if (model.startsWith("openai/")) return "openai";
    return "openrouter";
  }

  get keysConfigured(): boolean {
    return !!(this.openrouterApiKey || this.geminiApiKey || this.googleApiKey);
  }

  validate(): void {
    if (!this.keysConfigured && shouldWarnMissingApiKeys()) {
      console.warn(
        "No provider API keys configured. Add your own key in the dashboard or set OPENROUTER_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY.",
      );
    }
  }

  /**
   * Validate agent.yaml configuration with schema validation
   */
  validateAgentConfig(config: Record<string, unknown>): {
    valid: boolean;
    errors: string[];
  } {
    const result = validateRuntimeConfig(config);
    if (!result.valid) {
      const errors = result.errors.map((e) => `${e.path}: ${e.message}`);
      console.warn(
        "[Config] Invalid agent.yaml configuration:",
        errors.join("; "),
      );
      return { valid: false, errors };
    }
    if (result.warnings.length > 0) {
      console.warn(
        `[Config] Warnings: ${result.warnings
          .map((item) => `${item.path}: ${item.message}`)
          .join("; ")}`,
      );
    }
    return { valid: true, errors: [] };
  }

  private async updateEnvVar(key: string, value: string): Promise<void> {
    try {
      if (isSecretEnvKey(key)) {
        setEnvSecret(key, value);
        return;
      }
      let content = await fs.promises.readFile(ENV_PATH, "utf-8");
      const regex = new RegExp(`^${key}=.*$`, "m");
      const line = `${key}=${value}`;
      if (regex.test(content)) {
        content = content.replace(regex, line);
      } else {
        content = content.trim() + `\n${line}\n`;
      }
      await fs.promises.writeFile(ENV_PATH, content, "utf-8");
      process.env[key] = value;
    } catch (err) {
      console.error(`Failed to update ${key} in .env:`, err);
    }
  }

  setModel(model: string): void {
    this.updateEnvVar("DEFAULT_MODEL", model).catch((err) => {
      console.error("Failed to set model:", err);
    });
    this._modelChangeCallbacks.forEach((cb) => cb(model));
  }

  setTemperature(temp: number): void {
    this.updateEnvVar("DEFAULT_TEMPERATURE", String(temp)).catch((err) => {
      console.error("Failed to set temperature:", err);
    });
  }

  setMaxTokens(tokens: number): void {
    this.updateEnvVar("DEFAULT_MAX_TOKENS", String(tokens)).catch((err) => {
      console.error("Failed to set max tokens:", err);
    });
  }

  setApiKey(
    keyName: "OPENROUTER_API_KEY" | "GEMINI_API_KEY" | "GOOGLE_API_KEY",
    value: string,
  ): void {
    this.updateEnvVar(keyName, value).catch((err) => {
      console.error("Failed to set API key:", err);
    });
    this._apiKeyChangeCallbacks.forEach((cb) => cb());
  }

  onModelChange(callback: (model: string) => void): void {
    this._modelChangeCallbacks.push(callback);
  }

  onApiKeyChange(callback: () => void): void {
    this._apiKeyChangeCallbacks.push(callback);
  }

  getSupportedModels(): string[] {
    const custom = process.env["SUPPORTED_MODELS"] || "";
    const extras = custom
      ? custom
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    return [...BUILTIN_MODELS, ...extras];
  }
}

export const settings = Settings.getInstance();
settings.validate();
