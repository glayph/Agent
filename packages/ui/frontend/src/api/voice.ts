import { launcherFetch } from "./http"

export interface VoiceTranscriptionResult {
  ok: true
  transcript: string
  language: string
  duration_ms?: number
  provider: "whisper.cpp"
  model?: string
  latency_ms: number
  audio_retained: false
  transport: "endpoint" | "cli"
}

export class VoiceApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "VoiceApiError"
    this.status = status
    this.code = code
  }
}

export async function transcribeVoiceAudio(
  file: Blob,
  filename: string,
  durationMs?: number,
): Promise<VoiceTranscriptionResult> {
  const form = new FormData()
  form.append("audio", file, filename || "voice.webm")
  if (durationMs !== undefined && Number.isFinite(durationMs)) {
    form.append("duration_ms", String(Math.max(0, Math.round(durationMs))))
  }

  const response = await launcherFetch("/api/voice/transcribe", {
    method: "POST",
    body: form,
    showErrorToast: false,
  })
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown
    code?: unknown
  } & Partial<VoiceTranscriptionResult>
  if (
    !response.ok ||
    payload.ok !== true ||
    typeof payload.transcript !== "string"
  ) {
    throw new VoiceApiError(
      response.status,
      typeof payload.code === "string"
        ? payload.code
        : "voice_transcription_failed",
      typeof payload.error === "string"
        ? payload.error
        : "Voice transcription failed.",
    )
  }
  return payload as VoiceTranscriptionResult
}
