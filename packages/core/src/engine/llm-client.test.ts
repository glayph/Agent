import { createFetchLLMClient, createRegistryLLMClient, EngineLLMError } from "./llm-client.js";

const okBody = { choices: [{ message: { role: "assistant", content: "hi" } }], usage: { total_tokens: 3 } };
const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe("createFetchLLMClient", () => {
  it("posts tools and returns the parsed response", async () => {
    const fetchImpl = jest.fn(async () => json(200, okBody));
    const client = createFetchLLMClient({ baseUrl: "http://llm.test/v1/", model: "m", apiKey: "k", fetchImpl: fetchImpl as never, extraBody: { temperature: 0.2 } });
    const tools = [{ type: "function" as const, function: { name: "t", description: "d", parameters: {} } }];
    const response = await client.complete([{ role: "user", content: "hello" }], { tools });
    expect(response.choices?.[0].message?.content).toBe("hi");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://llm.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "m", tool_choice: "auto", temperature: 0.2 });
    expect(body.tools).toHaveLength(1);
  });

  it("retries transient failures but not client errors", async () => {
    const flaky = jest.fn()
      .mockResolvedValueOnce(json(503, { error: { message: "busy" } }))
      .mockResolvedValueOnce(json(200, okBody));
    const client = createFetchLLMClient({ baseUrl: "http://x", model: "m", fetchImpl: flaky as never, retryDelayMs: 1 });
    await expect(client.complete([{ role: "user", content: "a" }])).resolves.toBeDefined();
    expect(flaky).toHaveBeenCalledTimes(2);

    const bad = jest.fn(async () => json(401, { error: { message: "bad key" } }));
    const strict = createFetchLLMClient({ baseUrl: "http://x", model: "m", fetchImpl: bad as never, retryDelayMs: 1 });
    await expect(strict.complete([{ role: "user", content: "a" }])).rejects.toThrow("bad key");
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it("rejects a response without choices and gives up after the retries", async () => {
    const noChoices = jest.fn(async () => json(200, {}));
    const client = createFetchLLMClient({ baseUrl: "http://x", model: "m", fetchImpl: noChoices as never });
    await expect(client.complete([{ role: "user", content: "a" }])).rejects.toBeInstanceOf(EngineLLMError);

    const down = jest.fn(async () => { throw new Error("ECONNREFUSED"); });
    const unreachable = createFetchLLMClient({ baseUrl: "http://x", model: "m", fetchImpl: down as never, retries: 1, retryDelayMs: 1 });
    await expect(unreachable.complete([{ role: "user", content: "a" }])).rejects.toThrow("Could not reach");
    expect(down).toHaveBeenCalledTimes(2);
  });

  it("stops immediately when the caller aborts", async () => {
    const controller = new AbortController();
    const slow = jest.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const client = createFetchLLMClient({ baseUrl: "http://x", model: "m", fetchImpl: slow as never });
    const pending = client.complete([{ role: "user", content: "a" }], { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow("aborted");
    expect(slow).toHaveBeenCalledTimes(1);
  });
});

describe("createRegistryLLMClient", () => {
  it("passes tools through the provider registry's extra options", async () => {
    const complete = jest.fn(async () => okBody);
    const client = createRegistryLLMClient({ complete } as never, "gemini-flash");
    await client.complete([{ role: "user", content: "a" }], { tools: [{ type: "function", function: { name: "t", description: "d", parameters: {} } }], json: true });
    expect(complete).toHaveBeenCalledWith("gemini-flash", expect.any(Array), expect.objectContaining({ extra: expect.objectContaining({ tool_choice: "auto", response_format: { type: "json_object" } }) }));
  });
});
