/**
 * log-rotation.ts — Size-based rotating log stream with gzip compression.
 *
 * Uses only Node.js built-ins (fs, zlib, path) — no extra dependencies.
 * Drop-in replacement for fs.createWriteStream() for append-mode log files.
 */

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

export interface RotatingWriteStreamOptions {
  /** Max file size in bytes before rotation. Default: 50 MB */
  maxBytes?: number;
  /** Number of rotated (compressed) files to keep. Default: 7 */
  maxFiles?: number;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_MAX_FILES = 7;

/**
 * A writable stream that automatically rotates the underlying log file when
 * it exceeds `maxBytes`. Old rotations are gzip-compressed and named
 * `<basename>.1.gz`, `<basename>.2.gz`, …, `<basename>.N.gz`.
 *
 * Usage:
 *   const stream = new RotatingWriteStream("data/core_backend.log");
 *   stream.write("hello\n");
 */
export class RotatingWriteStream {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private stream: fs.WriteStream;
  private bytesWritten = 0;
  private rotating = false;
  // Writes that arrive while a rotation is in progress. this.stream is
  // being end()'d during rotate(); calling .write() on it after end() emits
  // an unhandled 'error' event that crashes the whole gateway process
  // (this stream carries the core backend's piped stdout/stderr, so this
  // could fire on every log rotation in a long-running deployment).
  // Buffered here and flushed onto the fresh stream once rotation finishes.
  private pendingWrites: Buffer[] = [];

  constructor(filePath: string, options: RotatingWriteStreamOptions = {}) {
    this.filePath = filePath;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

    // Get current file size so we pick up from where the previous run left off
    try {
      this.bytesWritten = fs.statSync(filePath).size;
    } catch {
      this.bytesWritten = 0;
    }

    this.stream = this._createStream();
  }

  private _createStream(): fs.WriteStream {
    const stream = fs.createWriteStream(this.filePath, { flags: "a" });
    stream.on("error", (err) => {
      console.error("[RotatingWriteStream] Stream error:", err);
    });
    return stream;
  }

  /** Write data to the stream; triggers rotation if threshold exceeded. */
  write(data: string | Buffer): void {
    const chunk = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
    this.bytesWritten += chunk.length;

    if (this.rotating) {
      this.pendingWrites.push(chunk);
    } else {
      this.stream.write(chunk);
    }

    if (this.bytesWritten >= this.maxBytes && !this.rotating) {
      this.rotate().catch((err) =>
        console.error("[RotatingWriteStream] Rotation error:", err),
      );
    }
  }

  /** Close the underlying stream. */
  end(): void {
    this.stream.end();
  }

  /** Rotate the log file: compress current → .1.gz, shift older files, start fresh. */
  private async rotate(): Promise<void> {
    this.rotating = true;
    let rotationSucceeded = false;
    try {
      // Close current stream first
      await new Promise<void>((resolve, reject) => {
        this.stream.end((err?: Error | null) =>
          err ? reject(err) : resolve(),
        );
      });

      // Shift existing rotations: .6.gz → .7.gz, .5.gz → .6.gz, etc.
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const src = `${this.filePath}.${i}.gz`;
        const dst = `${this.filePath}.${i + 1}.gz`;
        try {
          if (fs.existsSync(src)) fs.renameSync(src, dst);
        } catch {
          // Ignore individual rotation step failures
        }
      }

      // Remove the oldest if it exceeds maxFiles
      const oldest = `${this.filePath}.${this.maxFiles + 1}.gz`;
      try {
        if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
      } catch {
        /* ignore */
      }

      // Compress current log → .1.gz
      await this._compressFile(this.filePath, `${this.filePath}.1.gz`);

      // Truncate the current log file. Buffered writes are accounted for in
      // finally after the replacement stream is opened.
      fs.writeFileSync(this.filePath, "", { encoding: "utf-8" });
      rotationSucceeded = true;
    } catch (err) {
      console.error("[RotatingWriteStream] Failed to rotate:", err);
    } finally {
      // Re-open fresh stream and flush writes that arrived while the old
      // stream was being closed/compressed. When rotation succeeded, the
      // fresh file starts at zero, so retain the buffered byte count instead
      // of silently resetting it to zero. If the buffered data itself crosses
      // the threshold, schedule the next rotation after the flush.
      this.stream = this._createStream();
      const buffered = this.pendingWrites;
      this.pendingWrites = [];
      this.rotating = false;
      if (rotationSucceeded) this.bytesWritten = 0;
      for (const chunk of buffered) {
        this.stream.write(chunk);
        if (rotationSucceeded) this.bytesWritten += chunk.length;
      }
      if (this.bytesWritten >= this.maxBytes && !this.rotating) {
        this.rotate().catch((err) =>
          console.error("[RotatingWriteStream] Rotation error:", err),
        );
      }
    }
  }

  /** Gzip-compress `src` to `dst`. */
  private _compressFile(src: string, dst: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const input = fs.createReadStream(src);
      const output = fs.createWriteStream(dst);
      const gzip = zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED });

      input.on("error", reject);
      output.on("error", reject);
      output.on("finish", resolve);

      input.pipe(gzip).pipe(output);
    });
  }
}

/**
 * Convenience factory — mirrors `fs.createWriteStream(path, { flags: "a" })`.
 * Returns a RotatingWriteStream with the default 50 MB / 7-file settings,
 * unless the env var `LOG_ROTATION_DISABLED=true` is set (in which case
 * a plain WriteStream is returned for compatibility).
 */
export function createRotatingLogStream(
  filePath: string,
  options?: RotatingWriteStreamOptions,
): RotatingWriteStream | fs.WriteStream {
  if (process.env["LOG_ROTATION_DISABLED"] === "true") {
    return fs.createWriteStream(filePath, { flags: "a" });
  }
  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return new RotatingWriteStream(filePath, options);
}
