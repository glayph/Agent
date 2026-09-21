#!/usr/bin/env node
import fs from "node:fs/promises";
import { cookieHeaderFromNetscapeJar } from "./cookie-jar.mjs";

const base = process.env.MIKI_CHAT_BASE_URL || "http://127.0.0.1:18800";
const cookie = process.env.MIKI_CHAT_COOKIE || "/tmp/miki-cookie.txt";
const cookieHeader = cookieHeaderFromNetscapeJar(
  await fs.readFile(cookie, "utf8"),
);
const prompts = [
  [
    "answer",
    "Answer directly without tools. What is 2 + 2? Reply with one short sentence.",
    (text) => /\b4\b/.test(text),
  ],
  [
    "summary",
    "Summarize this in one sentence: Miki is a local-first agent. It can read files, create artifacts, and run safe tools. Users should verify important results.",
    (text) => /local-first/i.test(text),
  ],
  [
    "translation",
    "Translate exactly this sentence to Bengali: The local model is ready.",
    (text) => /স্থানীয়|মডেল|প্রস্তুত/.test(text),
  ],
  [
    "rewrite",
    "Rewrite this professionally in one sentence: the build is kinda broken and needs fixing.",
    (text) => /build|unstable|remediation|requires/i.test(text),
  ],
  [
    "extraction",
    "Extract the fields as plain lines in the format name=..., city=..., role=... from: Alice works as an engineer in Dhaka.",
    (text) => /name=Alice.*city=Dhaka.*role=engineer/i.test(text),
  ],
  [
    "write",
    "Create the file data/miki-level1-gemma.txt with exactly this content: local gemma level1 passed",
    (text) => !/error|unable|cannot|timeout/i.test(text),
  ],
  [
    "read",
    "Read data/miki-level1-gemma.txt and report its exact content.",
    (text) => /local gemma level1 passed/i.test(text),
  ],
  [
    "search",
    "Search the text in data/miki-level1-gemma.txt for the phrase local gemma and report whether it is present.",
    (text) => /local gemma|present|উপস্থিত/i.test(text),
  ],
];
const results = [];
for (const [name, message, validate] of prompts) {
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieHeader },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.json();
  const text = typeof body.response === "string" ? body.response.trim() : "";
  const ok =
    response.ok &&
    text.length > 0 &&
    !/^\[(?:Local AI timeout|LLM error)|^Error:/i.test(text) &&
    !/unable to|could not|cannot|did not finish|outside the active workspace/i.test(
      text,
    ) &&
    validate(text);
  results.push({
    name,
    ok,
    status: response.status,
    response: text.slice(0, 800),
    requestId: body.requestId,
  });
  console.log(JSON.stringify(results.at(-1)));
}
const file = await fs
  .readFile("data/miki-level1-gemma.txt", "utf8")
  .catch(() => "");
const writeOk = file === "local gemma level1 passed";
console.log(
  JSON.stringify({
    summary: {
      passed: results.filter((item) => item.ok).length,
      total: results.length,
      file_write_exact: writeOk,
    },
  }),
);
if (results.some((item) => !item.ok) || !writeOk) process.exitCode = 1;
