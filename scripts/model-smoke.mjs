#!/usr/bin/env node
/**
 * Opt-in model smoke tests. This intentionally performs no network call unless
 * --local and/or --gemini is supplied. It validates transport and a tiny
 * response only; it is not a quality benchmark or an agent workload.
 */

import process from "node:process";

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/model-smoke.mjs [--local] [--gemini] [--openai]

Local llama.cpp/LFM:
  MIKI_LOCAL_MODEL_ENDPOINT  default http://127.0.0.1:8080/v1
  MIKI_LOCAL_MODEL           model id sent to /chat/completions (default lfm2-local)

Gemini:
  GEMINI_API_KEY              required; never print this value
  GEMINI_MODEL                default gemini-3.5-flash-lite

OpenAI-compatible fallback:
  OPENAI_API_BASE or OPENAI_BASE_URL required; OPENAI_API_KEY required
  OPENAI_MODEL default gpt-5-mini

No provider is contacted unless its flag is supplied.`);
  process.exit(0);
}

const requested = ["--local", "--gemini", "--openai"].filter((flag) =>
  args.has(flag),
);
if (requested.length === 0) {
  console.error(
    "No model selected. Use --local, --gemini, --openai, or --help.",
  );
  process.exit(2);
}

const timeoutMs = Number(process.env.MIKI_MODEL_SMOKE_TIMEOUT_MS || 20_000);
const prompt = "Reply with exactly: miki model smoke test";

async function requestJson(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`,
      );
    }
    return body;
  } catch (error) {
    if (error instanceof Error && /^HTTP \d+/.test(error.message)) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs} ms: ${url}`);
    }
    const cause = error && typeof error === "object" ? error.cause : undefined;
    const causeCode =
      cause && typeof cause === "object" && "code" in cause
        ? String(cause.code)
        : "";
    const detail =
      causeCode || (error instanceof Error ? error.message : String(error));
    throw new Error(`Request failed for ${url}: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}

function extractText(body) {
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error(
      `Provider returned no assistant content: ${JSON.stringify(body).slice(0, 500)}`,
    );
  }
  return text.trim();
}

async function testLocal() {
  const endpoint = (
    process.env.MIKI_LOCAL_MODEL_ENDPOINT || "http://127.0.0.1:8080/v1"
  ).replace(/\/$/, "");
  const model = process.env.MIKI_LOCAL_MODEL || "lfm2-local";
  const body = await requestJson(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: Number(process.env.MIKI_MODEL_SMOKE_MAX_TOKENS || 128),
      temperature: 0,
      stream: false,
    }),
  });
  const text = extractText(body);
  console.log(
    JSON.stringify({
      provider: "local-llama.cpp",
      endpoint,
      model,
      ok: true,
      response: text,
    }),
  );
}

async function testOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for --openai");
  const base = (
    process.env.OPENAI_BASE_URL ||
    process.env.OPENAI_API_BASE ||
    ""
  ).replace(/\/$/, "");
  if (!base)
    throw new Error(
      "OPENAI_BASE_URL or OPENAI_API_BASE is required for --openai",
    );
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const body = await requestJson(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: Number(process.env.MIKI_MODEL_SMOKE_MAX_TOKENS || 128),
      temperature: 0,
      stream: false,
    }),
  });
  const text = extractText(body);
  console.log(
    JSON.stringify({
      provider: "openai-compatible",
      endpoint: base,
      model,
      ok: true,
      response: text,
    }),
  );
}

async function testGemini() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is required for --gemini");
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`;
  const body = await requestJson(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: Number(process.env.MIKI_MODEL_SMOKE_MAX_TOKENS || 128),
      temperature: 0,
      stream: false,
    }),
  });
  const text = extractText(body);
  console.log(
    JSON.stringify({ provider: "gemini", model, ok: true, response: text }),
  );
}

let failed = false;
for (const flag of requested) {
  try {
    if (flag === "--local") await testLocal();
    if (flag === "--gemini") await testGemini();
    if (flag === "--openai") await testOpenAI();
  } catch (error) {
    failed = true;
    console.error(
      JSON.stringify({
        provider: flag.slice(2),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
process.exitCode = failed ? 1 : 0;
