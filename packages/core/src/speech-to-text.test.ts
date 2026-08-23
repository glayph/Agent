import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SpeechToTextError, WhisperCppService } from "./speech-to-text.js";

describe("WhisperCppService", () => {
  function makeConfig(contents: string): string {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-whisper-test-"),
    );
    fs.writeFileSync(path.join(configDir, "agent.yaml"), contents, "utf8");
    return configDir;
  }

  it("is disabled by default and does not inspect or retain audio", async () => {
    const service = new WhisperCppService(
      makeConfig("speech_to_text:\n  enabled: false\n"),
    );
    await expect(
      service.transcribe({
        data: Buffer.from("not-audio"),
        filename: "voice.webm",
        mimeType: "audio/webm",
      }),
    ).rejects.toMatchObject<Partial<SpeechToTextError>>({
      status: 503,
      code: "speech_to_text_disabled",
    });
  });

  it("uses the active speech model record for endpoint transport", async () => {
    const service = new WhisperCppService(
      makeConfig(
        [
          "speech_to_text:",
          "  enabled: true",
          "  active_model_id: server-small",
          "  models:",
          "    - id: server-small",
          "      name: Whisper Server Small",
          "      transport: endpoint",
          "      endpoint: http://127.0.0.1:9",
        ].join("\n"),
      ),
    );
    await expect(
      service.transcribe({
        data: Buffer.from("RIFF0000WAVE", "ascii"),
        filename: "voice.wav",
        mimeType: "audio/wav",
      }),
    ).rejects.toMatchObject<Partial<SpeechToTextError>>({
      status: 502,
      code: "whisper_endpoint_unavailable",
    });
  });

  it("rejects a disguised upload before contacting the configured endpoint", async () => {
    const service = new WhisperCppService(
      makeConfig(
        [
          "speech_to_text:",
          "  enabled: true",
          "  endpoint: http://127.0.0.1:9",
          "  max_file_mb: 1",
        ].join("\n"),
      ),
    );
    await expect(
      service.transcribe({
        data: Buffer.from("this is not audio"),
        filename: "voice.webm",
        mimeType: "audio/webm",
      }),
    ).rejects.toMatchObject<Partial<SpeechToTextError>>({
      status: 415,
      code: "invalid_audio_signature",
    });
  });

  it("rejects audio longer than the configured duration bound", async () => {
    const service = new WhisperCppService(
      makeConfig(
        [
          "speech_to_text:",
          "  enabled: true",
          "  endpoint: http://127.0.0.1:9",
          "  max_audio_seconds: 30",
        ].join("\n"),
      ),
    );
    await expect(
      service.transcribe({
        data: Buffer.from("RIFF0000WAVE", "ascii"),
        filename: "voice.wav",
        mimeType: "audio/wav",
        clientDurationMs: 30_001,
      }),
    ).rejects.toMatchObject<Partial<SpeechToTextError>>({
      status: 413,
      code: "audio_too_long",
    });
  });

  it("rejects audio larger than the configured bound", async () => {
    const service = new WhisperCppService(
      makeConfig(
        [
          "speech_to_text:",
          "  enabled: true",
          "  endpoint: http://127.0.0.1:9",
          "  max_file_mb: 1",
        ].join("\n"),
      ),
    );
    const wavHeader = Buffer.from("RIFF0000WAVE", "ascii");
    const oversized = Buffer.concat([wavHeader, Buffer.alloc(1024 * 1024)]);
    await expect(
      service.transcribe({
        data: oversized,
        filename: "voice.wav",
        mimeType: "audio/wav",
      }),
    ).rejects.toMatchObject<Partial<SpeechToTextError>>({
      status: 413,
      code: "audio_too_large",
    });
  });
});
