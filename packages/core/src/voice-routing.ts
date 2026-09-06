import { settings } from "@miki/config";
import type { RuntimePaths } from "./paths.js";
import { supportsAudioModel } from "./llm.js";
import {
  VoiceRuntimeManager,
  type VoiceRuntimeStatus,
} from "./voice-runtime.js";
import {
  SpeechToTextError,
  WhisperCppService,
  type SpeechToTextResult,
} from "./speech-to-text.js";

export interface VoiceInput {
  data: Buffer;
  filename: string;
  mimeType: string;
  clientDurationMs?: number;
}

export interface CloudAudioHandoff {
  mode: "cloud";
  model: string;
  audio: { data: Buffer; filename: string; mimeType: string };
  voice: {
    provider: "cloud";
    transport: "cloud";
    language: string;
    durationMs?: number;
    model: string;
  };
}

export interface LocalTranscriptResult {
  mode: "local";
  transcript: SpeechToTextResult;
  voice: {
    provider: "whisper.cpp";
    transport: "endpoint" | "cli";
    language: string;
    durationMs?: number;
  };
}

export type VoiceRouteResult = LocalTranscriptResult | CloudAudioHandoff;

export class VoiceInputRouter {
  readonly runtime: VoiceRuntimeManager;
  private readonly localService: WhisperCppService;

  constructor(runtimePaths: RuntimePaths | string) {
    this.runtime = new VoiceRuntimeManager(runtimePaths);
    const configDir =
      typeof runtimePaths === "string" ? runtimePaths : runtimePaths.configDir;
    this.localService = new WhisperCppService(configDir);
  }

  status(): VoiceRuntimeStatus & { legacyConfigured: boolean } {
    const local = this.runtime.status();
    const settings = this.localService.getSettings();
    const legacyConfigured = Boolean(
      settings.enabled &&
      (settings.endpoint || (settings.executable && settings.model)),
    );
    return { ...local, legacyConfigured };
  }

  async route(
    input: VoiceInput,
    cloudModel = settings.defaultModel,
  ): Promise<VoiceRouteResult> {
    const localStatus = this.status();
    if (localStatus.healthy || localStatus.legacyConfigured) {
      const transcript = await this.localService.transcribe(input);
      return {
        mode: "local",
        transcript,
        voice: {
          provider: "whisper.cpp",
          transport: transcript.transport,
          language: transcript.language,
          ...(transcript.duration_ms !== undefined
            ? { durationMs: transcript.duration_ms }
            : {}),
        },
      };
    }

    const audioSupport = await supportsAudioModel(cloudModel);
    if (audioSupport === false) {
      throw new SpeechToTextError(
        422,
        "cloud_audio_unsupported",
        `The selected cloud model "${cloudModel}" does not support voice input. Install a local voice model or select an audio-capable cloud model.`,
      );
    }
    return {
      mode: "cloud",
      model: cloudModel,
      audio: input,
      voice: {
        provider: "cloud",
        transport: "cloud",
        language: "auto",
        ...(input.clientDurationMs !== undefined
          ? { durationMs: input.clientDurationMs }
          : {}),
        model: cloudModel,
      },
    };
  }
}
