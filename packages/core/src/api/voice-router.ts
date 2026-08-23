import { Router, type Request, type Response } from "express";
import {
  FileManagerError,
  multipartBoundary,
  parseMultipartForm,
  readRequestBuffer,
} from "./file-manager-router.js";
import { SpeechToTextError, WhisperCppService } from "../speech-to-text.js";

interface VoiceRouterOptions {
  configDir: string;
}

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function positiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function sendError(res: Response, error: unknown): void {
  const status =
    error instanceof SpeechToTextError || error instanceof FileManagerError
      ? error.status
      : 500;
  const code =
    error instanceof SpeechToTextError
      ? error.code
      : error instanceof FileManagerError
        ? "invalid_upload"
        : "voice_transcription_failed";
  res.status(status).json({
    error:
      error instanceof Error
        ? error.message
        : "Voice transcription failed unexpectedly.",
    code,
  });
}

export function createVoiceRouter({ configDir }: VoiceRouterOptions): Router {
  const router = Router();
  const service = new WhisperCppService(configDir);

  router.get("/status", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const settings = service.getSettings();
      const configured = Boolean(
        settings.enabled &&
        (settings.endpoint || (settings.executable && settings.model)),
      );
      res.json({
        enabled: settings.enabled,
        configured,
        provider: settings.provider,
        language: settings.language,
        max_file_mb: settings.max_file_mb,
        max_audio_seconds: settings.max_audio_seconds,
        transport: settings.endpoint
          ? "endpoint"
          : settings.executable
            ? "cli"
            : null,
        audio_retained: false,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/transcribe", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const settings = service.getSettings();
      const maxBytes = settings.max_file_mb * 1024 * 1024;
      const declaredLength = Number(
        firstHeaderValue(req.headers["content-length"]),
      );
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > maxBytes + 512 * 1024
      ) {
        throw new SpeechToTextError(
          413,
          "audio_too_large",
          `Audio exceeds the ${settings.max_file_mb} MB limit.`,
        );
      }
      const body = await readRequestBuffer(req, maxBytes + 512 * 1024);
      const boundary = multipartBoundary(req);
      const parsed = parseMultipartForm(body, boundary);
      const file = parsed.files.find(
        (item) => item.field === "audio" || item.field === "file",
      );
      if (!file) {
        throw new SpeechToTextError(
          400,
          "audio_required",
          "Attach one audio file in the audio field.",
        );
      }
      if (
        parsed.files.filter(
          (item) => item.field === "audio" || item.field === "file",
        ).length > 1
      ) {
        throw new SpeechToTextError(
          400,
          "one_audio_only",
          "Only one audio recording can be transcribed per request.",
        );
      }
      const result = await service.transcribe({
        data: file.data,
        filename: file.filename,
        mimeType: file.contentType || "",
        clientDurationMs: positiveNumber(parsed.fields.duration_ms),
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
