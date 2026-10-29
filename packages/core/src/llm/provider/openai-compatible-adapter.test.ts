import http from "node:http";
import { OpenAICompatibleAdapter } from "./openai-compatible-adapter.js";
import type { ProviderTransportConfig } from "./transport.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Test server did not bind a TCP port."));
      resolve(address.port);
    });
  });
}

function completionServer(onRequest: () => void): http.Server {
  return http.createServer(async (req, res) => {
    await new Promise<void>((resolve, reject) => {
      req.once("end", resolve);
      req.once("error", reject);
      req.resume();
    });
    onRequest();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "test-completion",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "gpt-test",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
}

describe("OpenAI-compatible provider client cache", () => {
  it("does not reuse a client when only the endpoint changes", async () => {
    let firstHits = 0;
    let secondHits = 0;
    const first = completionServer(() => { firstHits += 1; });
    const second = completionServer(() => { secondHits += 1; });
    const firstPort = await listen(first);
    const secondPort = await listen(second);
    const adapter = new OpenAICompatibleAdapter();
    const makeRequest = (port: number) => ({
      provider: {
        id: "miki-endpoint-cache-regression",
        displayName: "Test endpoint",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        emptyApiKeyAllowed: false,
      } satisfies ProviderTransportConfig,
      model: "gpt-test",
      apiKey: "sk-test-endpoint-key-123456789",
      messages: [{ role: "user" as const, content: "hello" }],
      timeoutMs: 5_000,
    });
    try {
      await adapter.complete(makeRequest(firstPort));
      await adapter.complete(makeRequest(secondPort));
      expect(firstHits).toBe(1);
      expect(secondHits).toBe(1);
    } finally {
      await Promise.all([first, second].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
  });
});

describe("OpenAI-compatible provider streaming", () => {
  it("forwards text deltas as they arrive and returns the assembled response", async () => {
    let streamedRequests = 0;
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk.toString();
      const body = JSON.parse(raw) as { stream?: boolean };
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "non-stream" }, finish_reason: "stop" }] }));
        return;
      }
      streamedRequests += 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const chunk = (delta: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-test",
        choices: [{ index: 0, delta, ...extra }],
      });
      res.write(`data: ${chunk({ role: "assistant", content: "Hel" })}\n\n`);
      res.write(`data: ${chunk({ content: "lo" })}\n\n`);
      res.write(`data: ${chunk({}, { finish_reason: "stop" })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    const port = await listen(server);
    const adapter = new OpenAICompatibleAdapter();
    const seen: string[] = [];
    try {
      const response = await adapter.complete({
        provider: {
          id: "miki-streaming-regression",
          displayName: "Test endpoint",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          emptyApiKeyAllowed: false,
        },
        model: "gpt-test",
        apiKey: "sk-test-stream-key-123456789",
        messages: [{ role: "user", content: "hello" }],
        timeoutMs: 5_000,
        onTextDelta: (delta) => seen.push(delta),
      });
      expect(streamedRequests).toBe(1);
      expect(seen).toEqual(["Hel", "lo"]);
      expect(response.choices?.[0]?.message?.content).toBe("Hello");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps streaming when only stream_options is rejected", async () => {
    const requests: Array<{ stream?: boolean; stream_options?: unknown }> = [];
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part.toString();
      const body = JSON.parse(raw) as { stream?: boolean; stream_options?: unknown };
      requests.push(body);
      if (body.stream_options) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stream_options is not supported" } }));
        return;
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "non-stream" }, finish_reason: "stop" }] }));
    });
    const port = await listen(server);
    const adapter = new OpenAICompatibleAdapter();
    const deltas: string[] = [];
    try {
      const response = await adapter.complete({
        provider: { id: "miki-stream-options-fallback", displayName: "Test endpoint", baseUrl: `http://127.0.0.1:${port}/v1`, emptyApiKeyAllowed: false },
        model: "gpt-test",
        apiKey: "sk-test-stream-options-key-123456789",
        messages: [{ role: "user", content: "hello" }],
        timeoutMs: 5_000,
        onTextDelta: (delta) => deltas.push(delta),
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]?.stream_options).toBeDefined();
      expect(requests[1]).toMatchObject({ stream: true });
      expect(requests[1]?.stream_options).toBeUndefined();
      expect(deltas).toEqual(["ok"]);
      expect(response.choices?.[0]?.message?.content).toBe("ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("retries without an unsupported optional thinking_level field", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part.toString();
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      if (Object.hasOwn(body, "thinking_level")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "unknown parameter thinking_level" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    });
    const port = await listen(server);
    const adapter = new OpenAICompatibleAdapter();
    try {
      const response = await adapter.complete({
        provider: { id: "miki-thinking-fallback", displayName: "Test endpoint", baseUrl: `http://127.0.0.1:${port}/v1`, emptyApiKeyAllowed: false },
        model: "gpt-test",
        apiKey: "sk-test-thinking-key-123456789",
        messages: [{ role: "user", content: "hello" }],
        extra: { temperature: 0.2, thinking_level: "low" },
        timeoutMs: 5_000,
      });
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toHaveProperty("thinking_level", "low");
      expect(bodies[1]).not.toHaveProperty("thinking_level");
      expect(bodies[1]).toHaveProperty("temperature", 0.2);
      expect(response.choices?.[0]?.message?.content).toBe("ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

});

