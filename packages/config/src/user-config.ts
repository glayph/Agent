import * as os from "os";
import * as path from "path";
import {
  createWorkspaceSecretVault,
  resolveEnvSecret,
  setEnvSecret,
} from "./secret-vault.js";
import { readMikiEnv } from "./env-compat.js";

const APP_DIR_NAME = "MikiAgent";

/** LLM provider API keys resolved from runtime env, user vault, then legacy workspace vault. */
export const PROVIDER_LLM_SECRET_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "AZURE_OPENAI_API_KEY",
] as const;

export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit =
    env["MIKIAGENT_CONFIG_DIR"] || readMikiEnv("MIKI_USER_CONFIG_DIR", env);
  if (explicit?.trim()) return path.resolve(explicit.trim());

  if (process.platform === "win32") {
    const base = env["APPDATA"] || env["LOCALAPPDATA"] || os.homedir();
    return path.join(base, APP_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      APP_DIR_NAME,
    );
  }
  const xdg = env["XDG_CONFIG_HOME"];
  return path.join(
    xdg?.trim() || path.join(os.homedir(), ".config"),
    APP_DIR_NAME,
  );
}

export function userSecretVault(env: NodeJS.ProcessEnv = process.env) {
  return createWorkspaceSecretVault(userConfigDir(env));
}

export function resolveUserSecret(key: string): string {
  try {
    return userSecretVault().get(`env/${key.trim().toUpperCase()}`) || "";
  } catch {
    return "";
  }
}

export function resolveConfiguredSecret(
  key: string,
  legacyWorkspaceDir?: string,
): string {
  const envValue = process.env[key];
  if (envValue?.trim()) return envValue;

  const userValue = resolveUserSecret(key);
  if (userValue) return userValue;

  return resolveEnvSecret(key, legacyWorkspaceDir);
}

export function setConfiguredSecret(key: string, value: string): void {
  setEnvSecret(key, value, userConfigDir());
}
export function loadConfiguredSecretsIntoEnv(
  keys: readonly string[] = PROVIDER_LLM_SECRET_KEYS,
  legacyWorkspaceDir?: string,
): void {
  for (const key of keys) {
    const value = resolveConfiguredSecret(key, legacyWorkspaceDir);
    if (value) {
      process.env[key] = value;
    }
  }
}

export function reloadProviderSecretsIntoEnv(
  legacyWorkspaceDir?: string,
): void {
  loadConfiguredSecretsIntoEnv(PROVIDER_LLM_SECRET_KEYS, legacyWorkspaceDir);
}
