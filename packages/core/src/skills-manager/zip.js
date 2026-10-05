import { inflateRawSync } from "node:zlib";
export const DEFAULT_ZIP_LIMITS = {
    maxEntries: 2000,
    maxTotalBytes: 50 * 1024 * 1024,
    maxFileBytes: 10 * 1024 * 1024,
};
export class ZipError extends Error {
}
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
export function isZip(buffer) {
    return buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_SIGNATURE;
}
function safeEntryPath(raw) {
    const normalised = raw.replace(/\\/g, "/");
    if (normalised.includes("\0"))
        throw new ZipError("Archive entry name is invalid.");
    if (normalised.startsWith("/") || /^[A-Za-z]:/.test(normalised))
        throw new ZipError(`Archive entry "${raw}" uses an absolute path.`);
    const parts = normalised.split("/").filter((part) => part && part !== ".");
    if (parts.some((part) => part === ".."))
        throw new ZipError(`Archive entry "${raw}" escapes the target folder.`);
    if (parts[0] === "__MACOSX")
        return null;
    return parts.length ? parts.join("/") : null;
}
/**
 * Minimal, defensive ZIP reader (stored + deflate). It refuses encrypted data,
 * ZIP64, symbolic links, path traversal and oversized archives instead of
 * extracting them, so the result can be written to disk without further checks
 * beyond the returned relative paths.
 */
export function readZip(buffer, limits = DEFAULT_ZIP_LIMITS) {
    let eocd = -1;
    const lowest = Math.max(0, buffer.length - 22 - 0xffff);
    for (let i = buffer.length - 22; i >= lowest; i--) {
        if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0)
        throw new ZipError("Not a valid ZIP archive.");
    const entryCount = buffer.readUInt16LE(eocd + 10);
    let cursor = buffer.readUInt32LE(eocd + 16);
    if (entryCount === 0xffff || cursor === 0xffffffff)
        throw new ZipError("ZIP64 archives are not supported.");
    if (entryCount > limits.maxEntries)
        throw new ZipError(`Archive has more than ${limits.maxEntries} entries.`);
    const files = [];
    const seen = new Set();
    let total = 0;
    for (let index = 0; index < entryCount; index++) {
        if (cursor + 46 > buffer.length ||
            buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE)
            throw new ZipError("ZIP central directory is corrupt.");
        const madeBy = buffer.readUInt16LE(cursor + 4);
        const flags = buffer.readUInt16LE(cursor + 8);
        const method = buffer.readUInt16LE(cursor + 10);
        const compressedSize = buffer.readUInt32LE(cursor + 20);
        const uncompressedSize = buffer.readUInt32LE(cursor + 24);
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const commentLength = buffer.readUInt16LE(cursor + 32);
        const externalAttributes = buffer.readUInt32LE(cursor + 38);
        const localOffset = buffer.readUInt32LE(cursor + 42);
        const rawName = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
        cursor += 46 + nameLength + extraLength + commentLength;
        if (compressedSize === 0xffffffff ||
            uncompressedSize === 0xffffffff ||
            localOffset === 0xffffffff)
            throw new ZipError("ZIP64 archives are not supported.");
        if (rawName.endsWith("/")) {
            safeEntryPath(rawName);
            continue;
        }
        // Unix mode lives in the high 16 bits when the archive was made on Unix (host 3).
        if (madeBy >> 8 === 3 && ((externalAttributes >>> 16) & 0xf000) === 0xa000)
            throw new ZipError(`Archive entry "${rawName}" is a symbolic link.`);
        if (flags & 0x1)
            throw new ZipError("Encrypted ZIP entries are not supported.");
        const entryPath = safeEntryPath(rawName);
        if (!entryPath)
            continue;
        if (seen.has(entryPath))
            throw new ZipError(`Archive contains "${entryPath}" twice.`);
        seen.add(entryPath);
        if (uncompressedSize > limits.maxFileBytes)
            throw new ZipError(`"${entryPath}" is larger than the per-file limit.`);
        total += uncompressedSize;
        if (total > limits.maxTotalBytes)
            throw new ZipError("Archive is larger than the total size limit.");
        if (localOffset + 30 > buffer.length ||
            buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE)
            throw new ZipError("ZIP local header is corrupt.");
        const localName = buffer.readUInt16LE(localOffset + 26);
        const localExtra = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localName + localExtra;
        const end = start + compressedSize;
        if (end > buffer.length)
            throw new ZipError("ZIP entry data is truncated.");
        const raw = buffer.subarray(start, end);
        let data;
        if (method === 0)
            data = Buffer.from(raw);
        else if (method === 8) {
            try {
                data = inflateRawSync(raw, { maxOutputLength: limits.maxFileBytes });
            }
            catch {
                throw new ZipError(`Could not decompress "${entryPath}".`);
            }
        }
        else
            throw new ZipError(`Unsupported compression method ${method} for "${entryPath}".`);
        if (data.length !== uncompressedSize)
            throw new ZipError(`Size mismatch for "${entryPath}".`);
        files.push({ path: entryPath, data });
    }
    return files;
}
