// Test double for the `openai` SDK. By default it answers locally with a canned reply. When the client
// is pointed at a loopback endpoint (a test's own HTTP server) it forwards the call there, so tests can
// observe which endpoint a client really talks to.
interface MockOptions {
  baseURL?: string;
}

const isLoopback = (url: string | undefined): url is string =>
  typeof url === "string" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);

export class OpenAI {
  constructor(private readonly options: MockOptions = {}) {}
  chat = {
    completions: {
      create: async (body?: unknown) => {
        if (isLoopback(this.options.baseURL)) {
          const response = await fetch(`${this.options.baseURL.replace(/\/+$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body ?? {}),
          });
          return response.json();
        }
        return { choices: [{ message: { content: "mock response" } }] };
      },
    },
  };
}

export default OpenAI;
