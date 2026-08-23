import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as yaml from "js-yaml";
import { SpeechToTextSchema, type SpeechToTextSettings } from "@miki/config";

export interface SpeechToTextInput {
  data: Buffer;
  filename: string;
  mimeType: string;
  clientDurationMs?: number;
}

export interface SpeechToTextResult {
  transcript: string;
  language: string;
  duration_ms?: number;
  provider: "whisper.cpp";
  model?: string;
  latency_ms: number;
  audio_retained: false;
  transport: "endpoint" | "cli";
}

export class SpeechToTextError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SpeechToTextError";
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 120;
const ALLOWED_MIME_TYPES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/ogg",
  "application/ogg",
  "audio/webm",
  "audio/flac",
  "audio/x-flac",
]);

interface RuntimeConfigFile {
  speech_to_text?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function envBoolean(...names: string[]): boolean | undefined {
  const value = envValue(...names)?.toLowerCase();
  if (!value) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

function envNumber(...names: string[]): number | undefined {
  const value = envValue(...names);
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function readSpeechConfig(configDir: string): Record<string, unknown> {
  const configPath = path.join(configDir, "agent.yaml");
  let fileConfig: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, "utf8")) as unknown;
    if (
      isRecord(parsed) &&
      isRecord((parsed as RuntimeConfigFile).speech_to_text)
    ) {
      fileConfig = (parsed as RuntimeConfigFile).speech_to_text as Record<
        string,
        unknown
      >;
    }
  } catch {
    // A missing or unreadable optional config is handled by environment values
    // and the disabled-by-default fallback below.
  }

  const environmentConfig: Record<string, unknown> = {};
  const enabled = envBoolean(
    "MIKI_SPEECH_TO_TEXT_ENABLED",
    "SPEECH_TO_TEXT_ENABLED",
  );
  const endpoint = envValue(
    "MIKI_WHISPER_CPP_ENDPOINT",
    "WHISPER_CPP_ENDPOINT",
  );
  const executable = envValue(
    "MIKI_WHISPER_CPP_EXECUTABLE",
    "WHISPER_CPP_EXECUTABLE",
  );
  const model = envValue("MIKI_WHISPER_CPP_MODEL", "WHISPER_CPP_MODEL");
  const language = envValue(
    "MIKI_SPEECH_TO_TEXT_LANGUAGE",
    "SPEECH_TO_TEXT_LANGUAGE",
  );
  const maxAudioSeconds = envNumber("MIKI_SPEECH_TO_TEXT_MAX_AUDIO_SECONDS");
  const maxFileMb = envNumber("MIKI_SPEECH_TO_TEXT_MAX_FILE_MB");
  const timeoutMs = envNumber("MIKI_SPEECH_TO_TEXT_TIMEOUT_MS");
  const concurrency = envNumber("MIKI_SPEECH_TO_TEXT_CONCURRENCY");
  if (enabled !== undefined) environmentConfig.enabled = enabled;
  if (endpoint) environmentConfig.endpoint = endpoint;
  if (executable) environmentConfig.executable = executable;
  if (model) environmentConfig.model = model;
  if (language) environmentConfig.language = language;
  if (maxAudioSeconds !== undefined) {
    environmentConfig.max_audio_seconds = maxAudioSeconds;
  }
  if (maxFileMb !== undefined) environmentConfig.max_file_mb = maxFileMb;
  if (timeoutMs !== undefined) environmentConfig.timeout_ms = timeoutMs;
  if (concurrency !== undefined) environmentConfig.concurrency = concurrency;

  const parsed = SpeechToTextSchema.safeParse({
    ...fileConfig,
    ...environmentConfig,
  });
  if (!parsed.success) {
    throw new SpeechToTextError(
      503,
      "invalid_configuration",
      "Speech-to-text configuration is invalid; check agent.yaml or environment overrides.",
    );
  }
  const config = parsed.data as SpeechToTextSettings;
  const hasDirectRuntimeOverride = Boolean(
    environmentConfig.endpoint ||
    environmentConfig.executable ||
    environmentConfig.model,
  );
  const activeModel = hasDirectRuntimeOverride
    ? undefined
    : config.models.find(
        (candidate) =>
          candidate.id === config.active_model_id &&
          candidate.enabled !== false,
      );
  if (activeModel) {
    return {
      ...config,
      ...(activeModel.transport === "endpoint"
        ? {
            endpoint: activeModel.endpoint,
            executable: undefined,
            model: undefined,
          }
        : {
            endpoint: undefined,
            executable: activeModel.executable,
            model: activeModel.model,
          }),
    } as Record<string, unknown>;
  }
  return config as Record<string, unknown>;
}

export function loadSpeechToTextSettings(
  configDir: string,
): SpeechToTextSettings {
  return readSpeechConfig(configDir) as SpeechToTextSettings;
}

function safeFilename(filename: string): string {
  const basename = path.basename(filename || "audio");
  const sanitized = basename
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, MAX_FILENAME_LENGTH);
  return sanitized || "audio";
}

function normalizedMime(mimeType: string): string {
  return mimeType.split(";", 1)[0].trim().toLowerCase();
}

function hasPrefix(data: Buffer, prefix: number[]): boolean {
  return (
    data.length >= prefix.length &&
    prefix.every((byte, index) => data[index] === byte)
  );
}

function looksLikeMp4(data: Buffer): boolean {
  return data.length >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp";
}

function looksLikeMp3(data: Buffer): boolean {
  return (
    data.subarray(0, 3).toString("ascii") === "ID3" ||
    (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0)
  );
}

function validateAudioSignature(
  data: Buffer,
  mimeType: string,
  filename: string,
): void {
  const mime = normalizedMime(mimeType);
  const extension = path.extname(filename).toLowerCase();
  const knownType =
    ALLOWED_MIME_TYPES.has(mime) ||
    [".wav", ".mp3", ".m4a", ".mp4", ".ogg", ".oga", ".webm", ".flac"].includes(
      extension,
    );
  if (!knownType) {
    throw new SpeechToTextError(
      415,
      "unsupported_audio_type",
      "Only common audio recordings (WAV, MP3, M4A, OGG, WebM, or FLAC) are accepted.",
    );
  }

  const signatureMatches =
    (hasPrefix(data, [0x52, 0x49, 0x46, 0x46]) &&
      data.subarray(8, 12).toString("ascii") === "WAVE") ||
    hasPrefix(data, [0x4f, 0x67, 0x67, 0x53]) ||
    hasPrefix(data, [0x66, 0x4c, 0x61, 0x43]) ||
    hasPrefix(data, [0x1a, 0x45, 0xdf, 0xa3]) ||
    looksLikeMp3(data) ||
    looksLikeMp4(data);
  if (!signatureMatches) {
    throw new SpeechToTextError(
      415,
      "invalid_audio_signature",
      "The uploaded file does not look like a supported audio recording.",
    );
  }
}

function boundedClientDuration(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined) return undefined;
  if (value < 0 || value > 3_600_000) return undefined;
  return Math.round(value);
}

function endpointPath(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, "");
  return /\/inference$/i.test(normalized)
    ? normalized
    : `${normalized}/inference`;
}

function extractTranscript(payload: unknown): string {
  if (isRecord(payload)) {
    if (typeof payload.text === "string") return payload.text.trim();
    if (typeof payload.transcript === "string")
      return payload.transcript.trim();
    if (Array.isArray(payload.segments)) {
      return payload.segments
        .filter(isRecord)
        .map((segment) =>
          typeof segment.text === "string" ? segment.text : "",
        )
        .join(" ")
        .trim();
    }
  }
  if (typeof payload === "string") return payload.trim();
  return "";
}

async function fetchJsonWithTimeout(
  url: string,
  form: FormData,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
      throw new SpeechToTextError(
        502,
        "response_too_large",
        "Whisper response is too large.",
      );
    }
    let payload: unknown = raw;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      // Some whisper-server builds return plain text for response_format=text.
    }
    if (!response.ok) {
      throw new SpeechToTextError(
        502,
        "whisper_endpoint_error",
        "The configured whisper.cpp endpoint rejected the audio request.",
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof SpeechToTextError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new SpeechToTextError(
        504,
        "transcription_timeout",
        "Speech transcription timed out.",
      );
    }
    throw new SpeechToTextError(
      502,
      "whisper_endpoint_unavailable",
      "The configured whisper.cpp endpoint is unavailable.",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function runWhisperCli(
  executable: string,
  model: string,
  audioPath: string,
  outputBase: string,
  language: string,
  timeoutMs: number,
): Promise<string> {
  const args = [
    "-m",
    model,
    "-f",
    audioPath,
    "-nt",
    "-otxt",
    "-of",
    outputBase,
  ];
  if (language) args.push("-l", language);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: path.dirname(executable),
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const collect = (target: "stdout" | "stderr") => (chunk: Buffer) => {
      if (target === "stdout")
        stdout = `${stdout}${chunk.toString("utf8")}`.slice(
          -MAX_RESPONSE_BYTES,
        );
      else
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(
          -MAX_RESPONSE_BYTES,
        );
    };
    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGKILL");
      reject(
        new SpeechToTextError(
          504,
          "transcription_timeout",
          "Speech transcription timed out.",
        ),
      );
    }, timeoutMs);
    child.once("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const code =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "whisper_executable_missing"
          : "whisper_cli_error";
      reject(
        new SpeechToTextError(
          503,
          code,
          "The configured whisper.cpp executable could not be started.",
        ),
      );
    });
    child.once("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new SpeechToTextError(
            502,
            "whisper_cli_failed",
            "whisper.cpp could not transcribe the audio.",
          ),
        );
        return;
      }
      const outputPath = `${outputBase}.txt`;
      let text = "";
      try {
        text = fs.readFileSync(outputPath, "utf8").trim();
      } catch {
        text = stdout
          .split(/\r?\n/)
          .filter(
            (line) =>
              line.trim() &&
              !/^whisper_|^main:|^system_info:|^ggml_/i.test(line.trim()),
          )
          .join(" ")
          .replace(/\[[^\]]+\]\s*/g, "")
          .trim();
      }
      if (!text) {
        reject(
          new SpeechToTextError(
            422,
            "empty_transcript",
            "No speech was detected in the audio.",
          ),
        );
        return;
      }
      resolve(text);
    });
  });
}

class ConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }
}

export class WhisperCppService {
  private gate: ConcurrencyGate | undefined;

  constructor(private readonly configDir: string) {}

  getSettings(): SpeechToTextSettings {
    return loadSpeechToTextSettings(this.configDir);
  }

  async transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult> {
    const settings = this.getSettings();
    if (!settings.enabled) {
      throw new SpeechToTextError(
        503,
        "speech_to_text_disabled",
        "Speech-to-text is disabled. Configure speech_to_text.enabled and a whisper.cpp runtime first.",
      );
    }
    const maxBytes =
      settings.max_file_mb * 1024 * 1024 || DEFAULT_MAX_FILE_BYTES;
    if (input.data.length === 0) {
      throw new SpeechToTextError(
        400,
        "empty_audio",
        "The audio recording is empty.",
      );
    }
    if (input.data.length > maxBytes) {
      throw new SpeechToTextError(
        413,
        "audio_too_large",
        `Audio exceeds the ${settings.max_file_mb} MB limit.`,
      );
    }
    const filename = safeFilename(input.filename);
    validateAudioSignature(input.data, input.mimeType, filename);
    const clientDurationMs = boundedClientDuration(input.clientDurationMs);
    if (
      clientDurationMs !== undefined &&
      clientDurationMs > settings.max_audio_seconds * 1000
    ) {
      throw new SpeechToTextError(
        413,
        "audio_too_long",
        `Audio exceeds the ${settings.max_audio_seconds} second limit.`,
      );
    }
    if (settings.endpoint && (settings.executable || settings.model)) {
      throw new SpeechToTextError(
        503,
        "ambiguous_configuration",
        "Configure either a whisper.cpp endpoint or executable/model paths, not both.",
      );
    }
    if (!settings.endpoint && !(settings.executable && settings.model)) {
      throw new SpeechToTextError(
        503,
        "runtime_not_configured",
        "No whisper.cpp endpoint or executable/model pair is configured.",
      );
    }

    this.gate ??= new ConcurrencyGate(settings.concurrency);
    const release = await this.gate.acquire();
    const startedAt = Date.now();
    let tempDir: string | undefined;
    try {
      let transcript: string;
      let transport: "endpoint" | "cli";
      let model: string | undefined;
      if (settings.endpoint) {
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(input.data)], {
            type: normalizedMime(input.mimeType) || "application/octet-stream",
          }),
          filename,
        );
        form.append("response_format", "json");
        if (settings.language !== "auto")
          form.append("language", settings.language);
        const payload = await fetchJsonWithTimeout(
          endpointPath(settings.endpoint),
          form,
          settings.timeout_ms,
        );
        transcript = extractTranscript(payload);
        transport = "endpoint";
        model = "whisper.cpp server";
      } else {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "miki-whisper-"));
        const audioPath = path.join(tempDir, filename);
        const outputBase = path.join(
          tempDir,
          `transcript-${crypto.randomUUID()}`,
        );
        await fsp.writeFile(audioPath, input.data, { mode: 0o600 });
        transcript = await runWhisperCli(
          settings.executable!,
          settings.model!,
          audioPath,
          outputBase,
          settings.language,
          settings.timeout_ms,
        );
        transport = "cli";
        model = path.basename(settings.model!);
      }
      if (!transcript) {
        throw new SpeechToTextError(
          422,
          "empty_transcript",
          "No speech was detected in the audio.",
        );
      }
      return {
        transcript: transcript.slice(0, 20_000),
        language: settings.language,
        ...(clientDurationMs !== undefined
          ? { duration_ms: clientDurationMs }
          : {}),
        provider: "whisper.cpp",
        model,
        latency_ms: Date.now() - startedAt,
        audio_retained: false,
        transport,
      };
    } finally {
      if (tempDir)
        await fsp
          .rm(tempDir, { recursive: true, force: true })
          .catch(() => undefined);
      release();
    }
  }
}
