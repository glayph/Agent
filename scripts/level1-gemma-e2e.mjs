#!/usr/bin/env node
import fs from "node:fs/promises";

const base = process.env.MIKI_CHAT_BASE_URL || "http://127.0.0.1:18800";
const cookie = process.env.MIKI_CHAT_COOKIE || "/tmp/miki-cookie.txt";
const cookieHeader = (await fs.readFile(cookie, "utf8"))
  .split(/\r?\n/)
  .filter(
    (line) => line && (!line.startsWith("#") || line.startsWith("#HttpOnly_")),
  )
  .map((line) => line.replace(/^#HttpOnly_/, ""))
  .map((line) => line.split("\t"))
  .filter((fields) => fields.length >= 7)
  .map((fields) => `${fields[5]}=${fields[6]}`)
  .join("; ");
const prompts = [
  [
    "answer",
    "Answer directly without tools. What is 2 + 2? Reply with one short sentence.",
  ],
  [
    "summary",
    "Summarize this in one sentence: Miki is a local-first agent. It can read files, create artifacts, and run safe tools. Users should verify important results.",
  ],
  [
    "translation",
    "Translate exactly this sentence to Bengali: The local model is ready.",
  ],
  [
    "rewrite",
    "Rewrite this professionally in one sentence: the build is kinda broken and needs fixing.",
  ],
  [
    "extraction",
    "Extract the fields as plain lines in the format name=..., city=..., role=... from: Alice works as an engineer in Dhaka.",
  ],
  [
    "write",
    "Create the file data/miki-level1-gemma.txt with exactly this content: local gemma level1 passed",
  ],
  ["read", "Read data/miki-level1-gemma.txt and report its exact content."],
  [
    "search",
    "Search the text in data/miki-level1-gemma.txt for the phrase local gemma and report whether it is present.",
  ],
];
const results = [];
for (const [name, message] of prompts) {
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieHeader },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.json();
  const text = typeof body.response === "string" ? body.response.trim() : "";
  const ok = response.ok && text.length > 0;
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
