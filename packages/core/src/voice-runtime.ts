import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { RuntimePaths } from "./paths.js";

export type VoiceModelTransport = "cli" | "endpoint";

export interface VoiceModelDefinition {
  id: string;
  name: string;
  description: string;
  languages: string;
  size: string;
  sha1: string;
  modelUrl: string;
  licenseUrl: string;
  transport: VoiceModelTransport;
}

export interface VoiceRuntimeState {
  activeModelId: string | null;
  models: Record<
    string,
    {
      id: string;
      path: string;
      installedAt: string;
      sha1: string;
      enabled: boolean;
    }
  >;
  runtime: {
    executable?: string;
    endpoint?: string;
    lastHealth?: {
      ok: boolean;
      checkedAt: string;
      reason: string;
    };
  };
}

export interface VoiceRuntimeStatus {
  installed: boolean;
  enabled: boolean;
  activeModelId: string | null;
  activeModelName: string | null;
  transport: VoiceModelTransport | null;
  runtimeConfigured: boolean;
  healthy: boolean;
  reason: string;
  modelDirectory: string;
  executable?: string;
  endpoint?: string;
  catalog: Array<
    VoiceModelDefinition & { installed: boolean; active: boolean }
  >;
}

const MODEL_REPOSITORY =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const WHISPER_LICENSE_URL =
  "https://github.com/ggml-org/whisper.cpp/raw/master/LICENSE";

/**
 * Only official whisper.cpp model artifacts are installable through the
 * autonomous path. SHA-1 values are the upstream model identifiers published
 * by whisper.cpp; the download is accepted only when the complete file matches.
 */
export const VOICE_MODEL_CATALOG: VoiceModelDefinition[] = [
  {
    id: "base",
    name: "Whisper base (multilingual)",
    description: "Good multilingual CPU baseline for Bengali and English.",
    languages: "multilingual",
    size: "142 MiB",
    sha1: "465707469ff3a37a2b9b8d8f89f2f99de7299dac",
    modelUrl: `${MODEL_REPOSITORY}/ggml-base.bin?download=true`,
    licenseUrl: WHISPER_LICENSE_URL,
    transport: "cli",
  },
  {
    id: "base.en",
    name: "Whisper base.en",
    description:
      "Smaller English-focused model for lower-latency English input.",
    languages: "English",
    size: "142 MiB",
    sha1: "137c40403d78fd54d454da0f9bd998f78703390c",
    modelUrl: `${MODEL_REPOSITORY}/ggml-base.en.bin?download=true`,
    licenseUrl: WHISPER_LICENSE_URL,
    transport: "cli",
  },
  {
    id: "small",
    name: "Whisper small (multilingual)",
    description:
      "Higher-quality multilingual transcription when more RAM is available.",
    languages: "multilingual",
    size: "466 MiB",
    sha1: "55356645c2b361a969dfd0ef2c5a50d530afd8d5",
    modelUrl: `${MODEL_REPOSITORY}/ggml-small.bin?download=true`,
    licenseUrl: WHISPER_LICENSE_URL,
    transport: "cli",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeModelId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new Error("Invalid voice model id.");
  }
  return id;
}

function defaultState(): VoiceRuntimeState {
  return { activeModelId: null, models: {}, runtime: {} };
}

function sha1File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function runtimeExecutableFromEnv(): string | undefined {
  const value = process.env.MIKI_WHISPER_CPP_EXECUTABLE?.trim();
  return value || undefined;
}

function runtimeEndpointFromEnv(): string | undefined {
  const value = process.env.MIKI_WHISPER_CPP_ENDPOINT?.trim();
  return value || undefined;
}

function normalizeState(value: unknown): VoiceRuntimeState {
  if (!isRecord(value)) return defaultState();
  const rawModels = isRecord(value.models) ? value.models : {};
  const models: VoiceRuntimeState["models"] = {};
  for (const [id, raw] of Object.entries(rawModels)) {
    if (!isRecord(raw) || typeof raw.path !== "string") continue;
    models[id] = {
      id,
      path: raw.path,
      installedAt:
        typeof raw.installedAt === "string"
          ? raw.installedAt
          : new Date(0).toISOString(),
      sha1: typeof raw.sha1 === "string" ? raw.sha1 : "",
      enabled: raw.enabled !== false,
    };
  }
  const runtime = isRecord(value.runtime) ? value.runtime : {};
  const lastHealth = isRecord(runtime.lastHealth)
    ? {
        ok: runtime.lastHealth.ok === true,
        checkedAt:
          typeof runtime.lastHealth.checkedAt === "string"
            ? runtime.lastHealth.checkedAt
            : new Date(0).toISOString(),
        reason:
          typeof runtime.lastHealth.reason === "string"
            ? runtime.lastHealth.reason
            : "Unknown",
      }
    : undefined;
  return {
    activeModelId:
      typeof value.activeModelId === "string" ? value.activeModelId : null,
    models,
    runtime: {
      ...(typeof runtime.executable === "string"
        ? { executable: runtime.executable }
        : {}),
      ...(typeof runtime.endpoint === "string"
        ? { endpoint: runtime.endpoint }
        : {}),
      ...(lastHealth ? { lastHealth } : {}),
    },
  };
}

export class VoiceRuntimeManager {
  readonly modelDirectory: string;
  private readonly statePath: string;

  constructor(runtimePaths: RuntimePaths | string) {
    const dataDir =
      typeof runtimePaths === "string"
        ? path.join(path.dirname(path.resolve(runtimePaths)), "data")
        : runtimePaths.dataDir;
    this.modelDirectory = path.join(dataDir, "voice", "models");
    this.statePath = path.join(dataDir, "voice", "state.json");
  }

  catalog(): VoiceRuntimeStatus["catalog"] {
    const state = this.readState();
    return VOICE_MODEL_CATALOG.map((model) => ({
      ...model,
      installed: Boolean(
        state.models[model.id]?.enabled &&
        fs.existsSync(state.models[model.id].path),
      ),
      active: state.activeModelId === model.id,
    }));
  }

  status(): VoiceRuntimeStatus {
    const state = this.readState();
    const active = state.activeModelId
      ? VOICE_MODEL_CATALOG.find((model) => model.id === state.activeModelId)
      : undefined;
    const installed = Boolean(
      active &&
      state.models[active.id]?.enabled &&
      fs.existsSync(state.models[active.id].path),
    );
    const executable = state.runtime.executable || runtimeExecutableFromEnv();
    const endpoint = state.runtime.endpoint || runtimeEndpointFromEnv();
    const runtimeConfigured = Boolean(
      endpoint || (executable && fs.existsSync(executable)),
    );
    const healthy = Boolean(
      installed && runtimeConfigured && state.runtime.lastHealth?.ok !== false,
    );
    let reason = "No local voice model is installed.";
    if (installed && !runtimeConfigured) {
      reason =
        "A local model is installed, but no whisper.cpp endpoint or executable is configured.";
    } else if (installed && state.runtime.lastHealth?.ok === false) {
      reason = state.runtime.lastHealth.reason;
    } else if (healthy) {
      reason = "Local voice-to-text model is installed and ready.";
    }
    return {
      installed,
      enabled: healthy,
      activeModelId: active?.id || null,
      activeModelName: active?.name || null,
      transport: active?.transport || null,
      runtimeConfigured,
      healthy,
      reason,
      modelDirectory: this.modelDirectory,
      ...(executable ? { executable } : {}),
      ...(endpoint ? { endpoint } : {}),
      catalog: this.catalog(),
    };
  }

  async install(modelId: string): Promise<VoiceRuntimeStatus> {
    const id = safeModelId(modelId);
    const definition = VOICE_MODEL_CATALOG.find((model) => model.id === id);
    if (!definition)
      throw new Error(`Voice model is not in the allow-listed catalog: ${id}`);
    await fsp.mkdir(this.modelDirectory, { recursive: true, mode: 0o700 });
    const destination = path.join(
      this.modelDirectory,
      `${id.replaceAll(".", "-")}.bin`,
    );
    const temporary = `${destination}.${process.pid}.${Date.now()}.part`;
    try {
      const response = await fetch(definition.modelUrl, { redirect: "follow" });
      if (!response.ok || !response.body) {
        throw new Error(
          `Voice model download failed with HTTP ${response.status}.`,
        );
      }
      await pipeline(
        response.body as unknown as NodeJS.ReadableStream,
        createWriteStream(temporary, { mode: 0o600 }),
      );
      const digest = await sha1File(temporary);
      if (digest !== definition.sha1) {
        throw new Error(`Voice model checksum mismatch for ${definition.id}.`);
      }
      await fsp.rename(temporary, destination);
      const state = this.readState();
      state.models[id] = {
        id,
        path: destination,
        installedAt: new Date().toISOString(),
        sha1: digest,
        enabled: true,
      };
      if (!state.activeModelId) state.activeModelId = id;
      state.runtime.executable ||= runtimeExecutableFromEnv();
      state.runtime.endpoint ||= runtimeEndpointFromEnv();
      await this.writeState(state);
      return this.status();
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async activate(modelId: string): Promise<VoiceRuntimeStatus> {
    const id = safeModelId(modelId);
    const state = this.readState();
    const record = state.models[id];
    if (!record || !record.enabled || !fs.existsSync(record.path)) {
      throw new Error(`Voice model is not installed: ${id}`);
    }
    state.activeModelId = id;
    await this.writeState(state);
    return this.status();
  }

  async remove(modelId: string): Promise<VoiceRuntimeStatus> {
    const id = safeModelId(modelId);
    const state = this.readState();
    const record = state.models[id];
    if (!record) throw new Error(`Voice model is not installed: ${id}`);
    await fsp.rm(record.path, { force: true });
    delete state.models[id];
    if (state.activeModelId === id) {
      state.activeModelId =
        Object.keys(state.models).find(
          (candidate) => state.models[candidate].enabled,
        ) || null;
    }
    await this.writeState(state);
    return this.status();
  }

  async health(): Promise<VoiceRuntimeStatus> {
    const state = this.readState();
    const status = this.status();
    let ok = status.installed && status.runtimeConfigured;
    let reason = status.reason;
    if (ok && status.endpoint) {
      try {
        const response = await fetch(status.endpoint.replace(/\/+$/, ""), {
          signal: AbortSignal.timeout(5000),
        });
        ok = response.ok;
        reason = ok
          ? "Local voice endpoint responded successfully."
          : `Local voice endpoint returned HTTP ${response.status}.`;
      } catch {
        ok = false;
        reason = "The configured local voice endpoint is unavailable.";
      }
    }
    state.runtime.lastHealth = {
      ok,
      checkedAt: new Date().toISOString(),
      reason,
    };
    await this.writeState(state);
    return this.status();
  }

  getActiveRuntime(): {
    executable?: string;
    endpoint?: string;
    model?: string;
  } {
    const state = this.readState();
    const active = state.activeModelId
      ? state.models[state.activeModelId]
      : undefined;
    return {
      ...(state.runtime.executable || runtimeExecutableFromEnv()
        ? { executable: state.runtime.executable || runtimeExecutableFromEnv() }
        : {}),
      ...(state.runtime.endpoint || runtimeEndpointFromEnv()
        ? { endpoint: state.runtime.endpoint || runtimeEndpointFromEnv() }
        : {}),
      ...(active?.path ? { model: active.path } : {}),
    };
  }

  private readState(): VoiceRuntimeState {
    try {
      return normalizeState(
        JSON.parse(fs.readFileSync(this.statePath, "utf8")),
      );
    } catch {
      return defaultState();
    }
  }

  private async writeState(state: VoiceRuntimeState): Promise<void> {
    await fsp.mkdir(path.dirname(this.statePath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await fsp.rename(temporary, this.statePath);
  }
}

export function defaultVoiceModelDirectory(): string {
  const root =
    process.env.XDG_DATA_HOME ||
    (process.platform === "win32" ? process.env.LOCALAPPDATA : undefined) ||
    path.join(os.homedir(), ".local", "share");
  return path.join(root, "Miki", "voice", "models");
}
