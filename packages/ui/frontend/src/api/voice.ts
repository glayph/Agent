import { launcherFetch } from "./http"

export interface VoiceTranscriptionResult {
  ok: true
  mode: "local"
  transcript: string
  language: string
  duration_ms?: number
  provider: "whisper.cpp"
  model?: string
  latency_ms: number
  audio_retained: false
  transport: "endpoint" | "cli"
}

export interface VoiceCloudAudioResult {
  ok: true
  mode: "cloud"
  model: string
  audio: {
    data: string
    filename: string
    mimeType: string
  }
  voice: {
    provider: "cloud"
    transport: "cloud"
    language: string
    durationMs?: number
    model: string
  }
}

export type VoiceInputResult = VoiceTranscriptionResult | VoiceCloudAudioResult

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
  model?: string,
): Promise<VoiceInputResult> {
  const form = new FormData()
  form.append("audio", file, filename || "voice.webm")
  if (durationMs !== undefined && Number.isFinite(durationMs)) {
    form.append("duration_ms", String(Math.max(0, Math.round(durationMs))))
  }
  if (model?.trim()) form.append("model", model.trim())

  const response = await launcherFetch("/api/voice/transcribe", {
    method: "POST",
    body: form,
    showErrorToast: false,
  })
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown
    code?: unknown
  } & Partial<VoiceTranscriptionResult> &
    Partial<VoiceCloudAudioResult>
  const isLocal =
    payload.ok === true &&
    payload.mode === "local" &&
    typeof payload.transcript === "string"
  const isCloud =
    payload.ok === true &&
    payload.mode === "cloud" &&
    typeof payload.model === "string" &&
    typeof payload.audio?.data === "string" &&
    typeof payload.audio?.mimeType === "string"
  if (!response.ok || (!isLocal && !isCloud)) {
    throw new VoiceApiError(
      response.status,
      typeof payload.code === "string"
        ? payload.code
        : "voice_transcription_failed",
      typeof payload.error === "string"
        ? payload.error
        : "Voice input could not be processed.",
    )
  }
  return payload as VoiceInputResult
}
