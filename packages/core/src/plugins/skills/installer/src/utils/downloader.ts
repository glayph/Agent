import * as https from "https";
import * as http from "http";
import * as fs from "fs";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 5 * 1024 * 1024;

export interface DownloadOptions {
  timeout?: number;
  headers?: Record<string, string>;
  maxBytes?: number;
  maxRedirects?: number;
  allowHttp?: boolean;
}

interface ResolvedDownloadOptions {
  timeout: number;
  headers?: Record<string, string>;
  maxBytes: number;
  maxRedirects: number;
  allowHttp: boolean;
}

function resolveOptions(
  options: DownloadOptions | undefined,
  defaultMaxBytes: number,
): ResolvedDownloadOptions {
  return {
    timeout: options?.timeout ?? DEFAULT_TIMEOUT_MS,
    headers: options?.headers,
    maxBytes: options?.maxBytes ?? defaultMaxBytes,
    maxRedirects: options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    allowHttp: options?.allowHttp ?? false,
  };
}

function parseDownloadUrl(
  sourceUrl: string,
  options: ResolvedDownloadOptions,
  baseUrl?: URL,
): URL {
  const parsedUrl = baseUrl ? new URL(sourceUrl, baseUrl) : new URL(sourceUrl);
  if (parsedUrl.protocol === "https:") return parsedUrl;
  if (parsedUrl.protocol === "http:" && options.allowHttp) return parsedUrl;
  throw new Error(
    `Refusing non-HTTPS download URL "${parsedUrl.toString()}". Set allowHttp only for trusted local development.`,
  );
}

function requestLibrary(url: URL): typeof https | typeof http {
  return url.protocol === "https:" ? https : http;
}

function isRedirect(statusCode: number | undefined): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode || 0);
}

function assertContentLengthWithinLimit(
  headers: http.IncomingHttpHeaders,
  maxBytes: number,
): void {
  const raw = Array.isArray(headers["content-length"])
    ? headers["content-length"][0]
    : headers["content-length"];
  if (!raw) return;
  const contentLength = Number.parseInt(raw, 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(
      `Download exceeds maximum size: ${contentLength} bytes > ${maxBytes} bytes`,
    );
  }
}

async function waitBeforeRetry(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
}

function resolveRedirectUrl(
  response: http.IncomingMessage,
  currentUrl: URL,
): URL {
  const redirectUrl = Array.isArray(response.headers.location)
    ? response.headers.location[0]
    : response.headers.location;
  if (!redirectUrl) {
    throw new Error(
      `Redirect (${response.statusCode}) with no Location header`,
    );
  }
  return new URL(redirectUrl, currentUrl);
}

async function downloadFileOnce(
  sourceUrl: URL,
  destPath: string,
  options: ResolvedDownloadOptions,
  redirectsRemaining: number,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const lib = requestLibrary(sourceUrl);
    const req = lib.get(
      sourceUrl,
      { headers: options.headers, timeout: options.timeout },
      (response) => {
        if (isRedirect(response.statusCode)) {
          try {
            if (redirectsRemaining <= 0) {
              throw new Error("Maximum redirect count exceeded");
            }
            const nextUrl = parseDownloadUrl(
              resolveRedirectUrl(response, sourceUrl).toString(),
              options,
            );
            response.resume();
            resolve(
              downloadFileOnce(
                nextUrl,
                destPath,
                options,
                redirectsRemaining - 1,
              ),
            );
          } catch (err) {
            response.resume();
            reject(err);
          }
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`),
          );
          return;
        }

        try {
          assertContentLengthWithinLimit(response.headers, options.maxBytes);
        } catch (err) {
          response.resume();
          reject(err);
          return;
        }

        const fileStream = fs.createWriteStream(destPath);
        let receivedBytes = 0;
        let settled = false;

        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          fileStream.destroy();
          fs.unlink(destPath, () => {});
          reject(err);
        };

        response.on("data", (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > options.maxBytes) {
            response.destroy(
              new Error(
                `Download exceeds maximum size: ${receivedBytes} bytes > ${options.maxBytes} bytes`,
              ),
            );
          }
        });
        response.on("error", (err) => fail(err));
        fileStream.on("error", (err) => fail(err));
        fileStream.on("finish", () => {
          if (settled) return;
          settled = true;
          fileStream.close();
          resolve(destPath);
        });

        response.pipe(fileStream);
      },
    );

    req.on("error", (err) => {
      reject(new Error(`Download failed: ${err.message}`));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Download timed out after ${options.timeout}ms`));
    });
  });
}

async function downloadTextOnce(
  sourceUrl: URL,
  options: ResolvedDownloadOptions,
  redirectsRemaining: number,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const lib = requestLibrary(sourceUrl);
    const req = lib.get(
      sourceUrl,
      { headers: options.headers, timeout: options.timeout },
      (response) => {
        if (isRedirect(response.statusCode)) {
          try {
            if (redirectsRemaining <= 0) {
              throw new Error("Maximum redirect count exceeded");
            }
            const nextUrl = parseDownloadUrl(
              resolveRedirectUrl(response, sourceUrl).toString(),
              options,
            );
            response.resume();
            resolve(downloadTextOnce(nextUrl, options, redirectsRemaining - 1));
          } catch (err) {
            response.resume();
            reject(err);
          }
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`),
          );
          return;
        }

        try {
          assertContentLengthWithinLimit(response.headers, options.maxBytes);
        } catch (err) {
          response.resume();
          reject(err);
          return;
        }

        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.on("data", (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > options.maxBytes) {
            response.destroy(
              new Error(
                `Download exceeds maximum size: ${receivedBytes} bytes > ${options.maxBytes} bytes`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", (err) => reject(err));
        response.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf-8")),
        );
      },
    );

    req.on("error", (err) =>
      reject(new Error(`Download failed: ${err.message}`)),
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Download timed out after ${options.timeout}ms`));
    });
  });
}

export async function downloadFile(
  sourceUrl: string,
  destPath: string,
  options?: DownloadOptions,
  retryCount: number = 3,
): Promise<string> {
  const resolvedOptions = resolveOptions(options, DEFAULT_MAX_FILE_BYTES);
  const parsedUrl = parseDownloadUrl(sourceUrl, resolvedOptions);

  for (let attempt = 0; attempt < retryCount; attempt++) {
    try {
      return await downloadFileOnce(
        parsedUrl,
        destPath,
        resolvedOptions,
        resolvedOptions.maxRedirects,
      );
    } catch (err) {
      if (attempt === retryCount - 1) throw err;
      await waitBeforeRetry(attempt);
    }
  }

  throw new Error("Download failed after retries");
}

export async function downloadText(
  sourceUrl: string,
  options?: DownloadOptions,
  retryCount: number = 3,
): Promise<string> {
  const resolvedOptions = resolveOptions(options, DEFAULT_MAX_TEXT_BYTES);
  const parsedUrl = parseDownloadUrl(sourceUrl, resolvedOptions);

  for (let attempt = 0; attempt < retryCount; attempt++) {
    try {
      return await downloadTextOnce(
        parsedUrl,
        resolvedOptions,
        resolvedOptions.maxRedirects,
      );
    } catch (err) {
      if (attempt === retryCount - 1) throw err;
      await waitBeforeRetry(attempt);
    }
  }
  throw new Error("Download failed after retries");
}

export async function downloadJson<T>(
  sourceUrl: string,
  options?: DownloadOptions,
): Promise<T> {
  const body = await downloadText(sourceUrl, options);
  return JSON.parse(body) as T;
}
