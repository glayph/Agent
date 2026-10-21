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
