# Whisper.cpp Speech-to-Text

## What is implemented

Agent Miki uses **whisper.cpp** as its local speech-to-text provider. The service accepts WAV, MP3, M4A, OGG, WebM, and FLAC uploads, enforces file and duration limits, writes temporary audio with restrictive permissions, and removes temporary files after transcription. Audio retention is disabled by design.

For CLI transport, native 16-bit mono 16 kHz WAV input is sent directly to `whisper-cli`. Browser microphone recordings and compressed uploads are normalized through `ffmpeg` to that format before the CLI is invoked. The normalization process uses `shell: false`, a bounded timeout, and generic error messages so local paths and decoder diagnostics are not returned to the client.

The implementation follows the upstream whisper.cpp workflow: build the `whisper-cli` example, download a converted `ggml` model, and transcribe an audio file with the CLI.[1] The upstream documentation notes that the CLI path expects 16-bit WAV input and gives the same 16 kHz mono PCM conversion pattern used here.[1]

## Linux setup

Build or install an official whisper.cpp checkout outside the Agent Miki repository. A CPU-only Release build is sufficient for the low-cost baseline:

```bash
git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_SDL2=OFF
cmake --build build --config Release --target whisper-cli --parallel 2
```

The expected executable is `build/bin/whisper-cli`. Configure it through the Agent Miki speech-to-text model settings or with the server-side environment variable `MIKI_WHISPER_CPP_EXECUTABLE`. If the executable is not on `PATH`, use its absolute path.

## Windows setup

Use the same official source with a Windows CMake generator and a native C/C++ toolchain. The resulting `whisper-cli.exe` must be configured through the model settings or `MIKI_WHISPER_CPP_EXECUTABLE`. The service invokes the executable without a shell, so paths containing spaces are supported and shell command injection is not used.

The microphone button is browser-dependent. A browser must expose `navigator.mediaDevices.getUserMedia` and `MediaRecorder`, and the user must grant microphone permission. The backend cannot grant that permission or validate a physical microphone from the sandbox.

## Model installation

The dashboard exposes an allow-listed catalog of official converted models. The low-cost multilingual baseline is `base` (approximately 142 MiB); the catalog records the expected SHA-1 digest and accepts a download only when the complete artifact matches. The model manager stores it under the application data directory with restrictive permissions, records an active model, and never downloads arbitrary model URLs.

A model can be installed through the dashboard’s speech-to-text model page. Installation is protected by the existing Agent Control approval flow. After installation, configure the native executable and run the local health check. A model-only installation is not considered ready until both the model and runtime are available.

## Validation checklist

| Check | Meaning |
|---|---|
| Model installed | The selected allow-listed model exists and its recorded checksum matched during installation. |
| Runtime configured | An endpoint or executable/model pair is configured. |
| Executable health | For CLI transport, `whisper-cli --help` exits successfully. This check never sends audio. |
| Upload conversion | Compressed or browser-recorded audio is converted to 16 kHz mono 16-bit PCM WAV before CLI inference. |
| Local transcription | A real audio sample is transcribed through the Miki service and returns `provider: whisper.cpp`, `transport: cli`, and `audio_retained: false`. |
| Microphone validation | Requires a target browser and physical/virtual microphone; repository tests cannot prove that hardware path. |

## Evidence collected in the development environment

A CPU-only `whisper-cli` Release build was compiled from the official `ggml-org/whisper.cpp` repository. The allow-listed multilingual `base` model was downloaded through the Agent Miki model manager and its expected SHA-1 matched. The upstream JFK WAV sample was transcribed directly and through the Agent Miki service. A compressed OGG version of the same sample was also transcribed through the service, proving the `ffmpeg` normalization path. The resulting transcript was:

> And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.

The service-level health check reported the model installed, runtime configured, and the executable responsive to `--help`. No user microphone was accessed and no audio was sent to a cloud provider.

## Remaining target-host evidence

A clean Windows host, a physical microphone, browser permission flow, and reboot/restart persistence still require validation on the target machine. The repository can validate the upload and CLI contracts, but it cannot honestly claim microphone hardware success without that host and user permission. Audio transcription remains local when the configured local runtime is healthy; cloud voice handoff is a separate path and is not required for Whisper.cpp operation.

## References

[1]: https://github.com/ggml-org/whisper.cpp — **ggml-org/whisper.cpp**, official repository README and CLI/model workflow.

[2]: https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md — **whisper.cpp model documentation**, converted model catalog and checksums.
