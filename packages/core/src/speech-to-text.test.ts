import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "@jest/globals";
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

  it("normalizes compressed audio before invoking the whisper CLI", async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-whisper-conversion-test-"),
    );
    const executable = path.join(configDir, "fake-whisper-cli.mjs");
    const ffmpeg = path.join(configDir, "fake-ffmpeg.mjs");
    const model = path.join(configDir, "model.bin");
    const shebang = "#!/usr/bin/env node\n";
    fs.writeFileSync(
      ffmpeg,
      `${shebang}import fs from "node:fs";\nconst output = process.argv.at(-1);\nconst header = Buffer.alloc(44);\nheader.write("RIFF", 0, "ascii");\nheader.write("WAVE", 8, "ascii");\nheader.writeUInt32LE(16, 16);\nheader.writeUInt16LE(1, 20);\nheader.writeUInt16LE(1, 22);\nheader.writeUInt32LE(16000, 24);\nheader.writeUInt32LE(32000, 28);\nheader.writeUInt16LE(2, 32);\nheader.writeUInt16LE(16, 34);\nheader.write("data", 36, "ascii");\nfs.writeFileSync(output, header);\n`,
      "utf8",
    );
    fs.writeFileSync(
      executable,
      `${shebang}import fs from "node:fs";\nconst args = process.argv.slice(2);\nconst output = args[args.indexOf("-of") + 1];\nfs.writeFileSync(output + ".txt", "converted local transcript");\n`,
      "utf8",
    );
    fs.chmodSync(executable, 0o755);
    fs.chmodSync(ffmpeg, 0o755);
    fs.writeFileSync(model, "test model", "utf8");
    const previousFfmpeg = process.env.MIKI_FFMPEG_EXECUTABLE;
    process.env.MIKI_FFMPEG_EXECUTABLE = ffmpeg;
    try {
      const service = new WhisperCppService(
        makeConfig(
          [
            "speech_to_text:",
            "  enabled: true",
            `  executable: ${executable}`,
            `  model: ${model}`,
          ].join("\n"),
        ),
      );
      const result = await service.transcribe({
        data: Buffer.from("OggScompressed-audio", "ascii"),
        filename: "voice.ogg",
        mimeType: "audio/ogg",
      });
      expect(result.transcript).toBe("converted local transcript");
      expect(result.transport).toBe("cli");
    } finally {
      if (previousFfmpeg === undefined)
        delete process.env.MIKI_FFMPEG_EXECUTABLE;
      else process.env.MIKI_FFMPEG_EXECUTABLE = previousFfmpeg;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
