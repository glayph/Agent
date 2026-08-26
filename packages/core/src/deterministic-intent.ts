export interface DeterministicFileRequest {
  path: string;
  content: string;
}

export interface DeterministicIntent {
  kind: "web_search" | "file_workflow";
  query?: string;
  files?: DeterministicFileRequest[];
  verificationRequested: boolean;
}

const FILE_OPERATION_PATTERN =
  /(?:create|write|make)\s+(?:a\s+)?(?:file\s+)?(?:named\s+)?([^\s,;:()]+)\s+(?:containing|with(?:\s+the)?\s+(?:text|content))\s+(?:exactly\s*:?\s*)?/gi;

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
  const matches = [...message.matchAll(FILE_OPERATION_PATTERN)];
  const requests: DeterministicFileRequest[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const rawPath = match[1] || "";
    const filePath = cleanFilePath(rawPath);
    if (!filePath || match.index === undefined) continue;
    const contentStart = (match.index ?? 0) + match[0].length;
    const nextStart = matches[index + 1]?.index ?? message.length;
    const content = cleanContent(message.slice(contentStart, nextStart));
    if (!content) continue;
    requests.push({ path: filePath, content });
  }
  return requests;
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
  const files = parseFileRequests(message);
  if (files.length > 0) {
    return {
      kind: "file_workflow",
      files,
      verificationRequested:
        /\b(verify|check|confirm|exists|read\s+back)\b/i.test(message),
    };
  }

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

export function isExplicitToolIntent(
  message: string,
  toolName: string,
): boolean {
  const intent = detectDeterministicIntent(message);
  if (!intent) return false;
  if (intent.kind === "web_search") return toolName === "web_search";
  return toolName === "file_write" || toolName === "file_read";
}
