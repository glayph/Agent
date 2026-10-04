export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** JSON.stringify with sorted object keys, so equal inputs give equal strings. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max))}\n…[truncated ${text.length - max} characters]`;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Strip well-known credential shapes before text is sent back to a model. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[REDACTED]"),
    text,
  );
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Reject as soon as `signal` aborts, otherwise settle like `promise`. */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Minimal JSON-schema check (required keys and primitive types). It exists so
 * a model's malformed arguments become a clear tool error it can correct,
 * instead of an exception deep inside a tool.
 */
export function validateArguments(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, { type?: string }>)
      : {};
  const required = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null)
      return `Missing required argument "${key}".`;
  }
  for (const [key, value] of Object.entries(args)) {
    const expected = properties[key]?.type;
    if (!expected || value === undefined || value === null) continue;
    const actual = Array.isArray(value) ? "array" : typeof value;
    const ok =
      expected === "integer"
        ? Number.isInteger(value)
        : expected === "number"
          ? typeof value === "number"
          : actual === expected;
    if (!ok) return `Argument "${key}" must be of type ${expected}.`;
  }
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).filter((key) => !(key in properties));
    if (unknown.length) return `Unknown argument(s): ${unknown.join(", ")}.`;
  }
  return null;
}
