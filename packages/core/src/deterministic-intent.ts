export interface DeterministicFileRequest {
  path: string;
  content: string;
}

export interface DeterministicIntent {
  kind: "web_search" | "file_workflow" | "process_control" | "math" | "file_delete";
  query?: string;
  files?: DeterministicFileRequest[];
  deletePaths?: string[];
  expression?: string;
  answer?: string;
  verificationRequested: boolean;
}

const FILE_OPERATION_PATTERN =
  /(?:create|write|make)\s+(?:a\s+)?(?:file\s+)?(?:named\s+)?([^\s,;:()]+)\s+(?:containing|with(?:\s+the)?\s+(?:text|content))\s+(?:exactly\s*:?\s*)?/gi;

// Also accept the common UI-friendly form used for multiple files:
// `folder/file.md` containing exactly `...` and `folder/data.json` containing
// exactly `...`. The content delimiter is captured so JSON quotes remain part
// of the file body instead of terminating the match.
const QUOTED_FILE_OPERATION_PATTERN =
  /([`'\"])([a-zA-Z0-9][a-zA-Z0-9._/-]*)\1\s+(?:containing|with(?:\s+the)?\s+(?:text|content))\s+(?:exactly\s*:?\s*)([`'\"])([\s\S]*?)\3/gi;

function cleanFilePath(value: string): string | null {
  const candidate = value.trim().replace(/^['"`]|['"`]$/g, "");
  if (
    !candidate ||
    candidate.includes("..") ||
    candidate.startsWith("/") ||
    candidate.includes("\\")
  ) {
    return null;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(candidate)) return null;
  return candidate;
}

function cleanContent(value: string): string {
  let content = value.trim();
  content = content.replace(
    /\s+(?:then|and)\s+(?:verify|check|confirm|report)\b[\s\S]*$/i,
    "",
  );
  content = content.replace(/[.!?;,:]+$/, "").trim();
  if (content.length >= 2) {
    const first = content[0];
    const last = content[content.length - 1];
    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "`" && last === "`")
    ) {
      content = content.slice(1, -1);
    }
  }
  return content.trim();
}

function parseFileRequests(message: string): DeterministicFileRequest[] {
  const requests: DeterministicFileRequest[] = [];
  const seen = new Set<string>();
  const addRequest = (filePath: string | null, content: string): void => {
    if (!filePath || !content) return;
    const key = `${filePath}\u0000${content}`;
    if (seen.has(key)) return;
    seen.add(key);
    requests.push({ path: filePath, content });
  };

  const matches = [...message.matchAll(FILE_OPERATION_PATTERN)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const rawPath = match[1] || "";
    const filePath = cleanFilePath(rawPath);
    if (!filePath || match.index === undefined) continue;
    const contentStart = (match.index ?? 0) + match[0].length;
    const nextStart = matches[index + 1]?.index ?? message.length;
    addRequest(filePath, cleanContent(message.slice(contentStart, nextStart)));
  }

  for (const match of message.matchAll(QUOTED_FILE_OPERATION_PATTERN)) {
    // Quoted content is explicitly exact: preserve punctuation and JSON syntax.
    addRequest(cleanFilePath(match[2] || ""), (match[4] || "").trim());
  }
  return requests;
}

function normalizeMathDigits(value: string): string {
  const bengaliDigits = "০১২৩৪৫৬৭৮৯";
  return value.replace(/[০-৯]/g, (digit) =>
    String(bengaliDigits.indexOf(digit)),
  );
}

function parseMathIntent(message: string): DeterministicIntent | null {
  const normalized = normalizeMathDigits(message).trim();
  const match = normalized.match(
    /(-?(?:\d+(?:\.\d+)?|\.\d+))\s*([-+*/%×÷])\s*(-?(?:\d+(?:\.\d+)?|\.\d+))/,
  );
  if (!match || match.index === undefined) return null;

  const context = `${normalized.slice(0, match.index)} ${normalized.slice(
    match.index + match[0].length,
  )}`;
  if (
    context.length > 140 ||
    /\b(create|write|search|browse|research|file|page|tool|run|execute|then|and|website|landing)\b|(?:ফাইল|ওয়েব|ওয়েব|সার্চ|রিসার্চ|তৈরি|লিখ|তারপর|ব্রাউজ)/i.test(
      context,
    )
  ) {
    return null;
  }

  const left = Number(match[1]);
  const right = Number(match[3]);
  const operator = match[2];
  let answer: number;
  switch (operator) {
    case "+":
      answer = left + right;
      break;
    case "-":
      answer = left - right;
      break;
    case "*":
    case "×":
      answer = left * right;
      break;
    case "/":
    case "÷":
      if (right === 0) return null;
      answer = left / right;
      break;
    case "%":
      if (right === 0) return null;
      answer = left % right;
      break;
    default:
      return null;
  }
  if (!Number.isFinite(answer)) return null;
  return {
    kind: "math",
    expression: match[0].replace(/×/g, "*").replace(/÷/g, "/"),
    answer: String(answer),
    verificationRequested: false,
  };
}

const PROCESS_CONTROL_PATTERN =
  /(?:process|প্রসেস|pid|background\s+job).{0,100}(?:stop|kill|terminate|বন্ধ|sigterm|sigkill)|(?:stop|kill|terminate|বন্ধ).{0,100}(?:process|প্রসেস|pid|background\s+job)/i;
const SAFE_DISPOSABLE_PROCESS_PATTERN =
  /\b(?:safe|disposable|temporary|test)\b[\s\S]{0,140}\bsleep\b[\s\S]{0,180}\b(?:kill|terminate|stop)\b/i;

function parseProcessControlIntent(message: string): DeterministicIntent | null {
  if (!PROCESS_CONTROL_PATTERN.test(message)) return null;
  // Only auto-execute the tightly bounded disposable-process test. General
  // process-control requests still go through the normal model/tool path and
  // its safety policy; this deterministic path cannot target an existing PID.
  if (!SAFE_DISPOSABLE_PROCESS_PATTERN.test(message)) return null;
  return { kind: "process_control", verificationRequested: true };
}

export function isExplicitProcessControlRequest(message: string): boolean {
  return PROCESS_CONTROL_PATTERN.test(message);
}

// BUG-09 FIX: "delete/remove <file>" was previously invisible to the
// deterministic-intent classifier. explicitToolNames() in
// adaptive-capability-selector.ts only recognized "file_workflow" (mapping
// to file_write/file_read) and "web_search" — file_delete had no route into
// the required-tools set. Combined with isSafeForAmbiguousTurn() filtering
// out any tool whose *name* contains "delete", a plain "delete greeting
// file" request on a simple/no-verification turn could end up with
// file_delete completely absent from the turn's tool schema, or present in
// the schema but then rejected at execution time as "not selected for this
// turn" if the model still attempted it via a stale tool reference. Detecting
// the intent explicitly here fixes both paths.
const FILE_DELETE_PATTERN =
  /\b(?:delete|remove|erase)\b.{0,60}\b(?:file|document|doc)\b|\b(?:file|document|doc)\b.{0,40}\b(?:delete|remove|erase)\b|(?:মুছ|ডিলিট|মুছে\s*ফেল|রিমুভ)/i;

function parseFileDeleteIntent(message: string): DeterministicIntent | null {
  if (!FILE_DELETE_PATTERN.test(message)) return null;
  // Best-effort filename extraction so the caller can present a helpful
  // preview; the actual path still comes from the model's tool call args,
  // this is only used to decide *whether* file_delete belongs in the turn's
  // tool set, not to auto-execute a delete.
  const quoted = message.match(/[`'"]([^`'"]+\.[a-zA-Z0-9]{1,8})[`'"]/);
  const bare = message.match(
    /\b([a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z0-9]{1,8})\b/,
  );
  const deletePaths = [quoted?.[1] || bare?.[1]].filter(
    (v): v is string => Boolean(v),
  );
  return {
    kind: "file_delete",
    deletePaths,
    verificationRequested: /\b(verify|check|confirm|exists)\b/i.test(message),
  };
}

function searchQueryFromMessage(message: string): string {
  const url = message.match(/https?:\/\/[^\s<>()]+/i)?.[0];
  if (url) return url.replace(/[.,;:]+$/, "");
  const match = message.match(
    /(?:search|look\s+up|find)\s+(?:the\s+)?(?:web|internet)?\s*(?:for|about)?\s*(.+?)(?:\s+and\s+(?:return|give|tell)\b|$)/i,
  );
  return (match?.[1] || message).trim();
}

export function detectDeterministicIntent(
  message: string,
): DeterministicIntent | null {
  // BUG-09 FIX: check delete intent before the generic file-write pattern.
  // "delete greeting.txt" would not match FILE_OPERATION_PATTERN (which
  // requires create/write/make + containing/with content) so ordering here
  // does not currently cause false positives either way, but checking delete
  // first keeps intent priority explicit as more file-intent kinds are added.
  const fileDelete = parseFileDeleteIntent(message);
  if (fileDelete) return fileDelete;

  const files = parseFileRequests(message);
  if (files.length > 0) {
    return {
      kind: "file_workflow",
      files,
      verificationRequested:
        /\b(verify|check|confirm|exists|read\s+back)\b/i.test(message),
    };
  }

  const processControl = parseProcessControlIntent(message);
  if (processControl) return processControl;

  const math = parseMathIntent(message);
  if (math) return math;

  if (
    /\b(web\s+search|search\s+the\s+web|search\s+online|search\s+the\s+internet|look\s+it\s+up)\b/i.test(
      message,
    ) ||
    /(?:ওয়েব|ওয়েব|অনলাইন).*(?:সার্চ|খুঁজ|অনুসন্ধান)/i.test(message)
  ) {
    return {
      kind: "web_search",
      query: searchQueryFromMessage(message),
      verificationRequested: true,
    };
  }

  return null;
}

export function suppressVisibleStatusForIntent(message: string): boolean {
  const intent = detectDeterministicIntent(message);
  return intent?.kind === "math" && !intent.verificationRequested;
}

export function isExplicitToolIntent(
  message: string,
  toolName: string,
): boolean {
  const intent = detectDeterministicIntent(message);
  if (!intent) return false;
  if (intent.kind === "web_search") return toolName === "web_search";
  if (intent.kind === "file_workflow") {
    return toolName === "file_write" || toolName === "file_read";
  }
  if (intent.kind === "file_delete") return toolName === "file_delete";
  if (intent.kind === "process_control") {
    return toolName === "shell_execute";
  }
  return false;
}
