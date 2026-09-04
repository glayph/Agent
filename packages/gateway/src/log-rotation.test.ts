import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RotatingWriteStream } from "./log-rotation.js";

function waitForIo(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

describe("RotatingWriteStream", () => {
  it("accounts for writes buffered while a rotation is in progress", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-log-rotation-"),
    );
    const logPath = path.join(tempDir, "core.log");
    const stream = new RotatingWriteStream(logPath, {
      maxBytes: 3,
      maxFiles: 2,
    });

    try {
      stream.write("abc");
      stream.write("d");
      await waitForIo();

      expect(fs.readFileSync(logPath, "utf8")).toBe("d");
      expect((stream as unknown as { bytesWritten: number }).bytesWritten).toBe(
        1,
      );
    } finally {
      stream.end();
      await waitForIo();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
