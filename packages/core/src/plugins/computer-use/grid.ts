/**
 * computer-grid.ts — Utility for drawing coordinate grids on PNG screenshots.
 *
 * Provides a lightweight coordinate grid generator for computer tool screenshots.
 * Draws grid lines every N pixels (default 100px) with numeric labels, allowing the LLM
 * to visually identify exact pixel coordinates for click_at / drag actions.
 */

import * as zlib from "zlib";

/**
 * Superimposes a coordinate grid over a raw RGBA pixel buffer and returns a PNG buffer.
 */
export function drawGridOverlay(
  rgbaBuffer: Buffer,
  width: number,
  height: number,
  gridStep = 100,
): Buffer {
  // Copy buffer so we don't mutate original
  const out = Buffer.from(rgbaBuffer);

  // Line colors (semi-transparent bright cyan for grid lines)
  const lineR = 0;
  const lineG = 220;
  const lineB = 255;
  const lineA = 180;

  // Draw vertical grid lines
  for (let x = 0; x < width; x += gridStep) {
    for (let y = 0; y < height; y++) {
      const idx = (y * width + x) * 4;
      if (idx + 3 < out.length) {
        out[idx] = lineR;
        out[idx + 1] = lineG;
        out[idx + 2] = lineB;
        out[idx + 3] = lineA;
      }
    }
  }

  // Draw horizontal grid lines
  for (let y = 0; y < height; y += gridStep) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (idx + 3 < out.length) {
        out[idx] = lineR;
        out[idx + 1] = lineG;
        out[idx + 2] = lineB;
        out[idx + 3] = lineA;
      }
    }
  }

  return encodeUncompressedPng(out, width, height);
}

/**
 * Creates a raw uncompressed PNG buffer from RGBA data.
 */
function encodeUncompressedPng(
  rgba: Buffer,
  width: number,
  height: number,
): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdrChunk = createPngChunk("IHDR", ihdrData);

  // IDAT chunk
  const scanlineSize = width * 4 + 1;
  const rawData = Buffer.alloc(height * scanlineSize);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * scanlineSize;
    rawData[rowOffset] = 0; // Filter type 0 (None)
    rgba.copy(rawData, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressedData = zlib.deflateSync(rawData);
  const idatChunk = createPngChunk("IDAT", compressedData);

  // IEND chunk
  const iendChunk = createPngChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const length = data.length;
  const chunk = Buffer.alloc(12 + length);
  chunk.writeUInt32BE(length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);

  const crc32 = calcCrc32(chunk.subarray(4, 8 + length));
  chunk.writeUInt32BE(crc32, 8 + length);
  return chunk;
}

// CRC32 calculation table
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function calcCrc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}
