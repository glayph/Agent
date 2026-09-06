import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface JsonRpcTestMessage {
  id?: number;
  result?: {
    protocolVersion?: string;
    serverInfo?: { name?: string };
    capabilities?: unknown;
    tools?: Array<{ name?: string; inputSchema?: { type?: string } }>;
    content?: Array<{ text?: string }>;
    resources?: Array<{ uri?: string }>;
    prompts?: Array<{ name?: string }>;
  };
  error?: { code?: number };
}

class TestTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown, extra?: unknown) => void;
  sentMessages: JsonRpcTestMessage[] = [];

  async start(): Promise<void> {
    // no-op for testing
  }

  async close(): Promise<void> {
    // no-op for testing
  }

  async send(message: unknown): Promise<void> {
    this.sentMessages.push(message as JsonRpcTestMessage);
  }

  receive(message: unknown): void {
    this.onmessage?.(message);
  }
}

function request(id: number, method: string, params?: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method, params };
}

function findResponse(
  transport: TestTransport,
  id: number,
): JsonRpcTestMessage {
  const response = transport.sentMessages.find((message) => message.id === id);
  if (!response) throw new Error(`Response ${id} not found`);
  return response;
}

function createTestServer(): McpServer {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.registerTool(
    "test-tool",
    {
      description: "A test tool",
      inputSchema: z.object({
        message: z.string().describe("Test message"),
      }),
    },
    async (args) => ({
      content: [{ type: "text" as const, text: `Echo: ${args.message}` }],
    }),
  );

  server.resource(
    "Test Resource",
    "test://data",
    {
      description: "A test resource",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: '{"key": "value"}',
        },
      ],
    }),
  );

  server.registerPrompt(
    "test-prompt",
    {
      description: "A test prompt",
      argsSchema: {
        topic: z.string().describe("The topic"),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Tell me about ${args.topic}`,
          },
        },
      ],
    }),
  );

  return server;
}

describe("McpServer (SDK-based)", () => {
  let server: McpServer;
  let transport: TestTransport;

  beforeEach(async () => {
    server = createTestServer();
    transport = new TestTransport();
    await server.connect(
      transport as unknown as Parameters<McpServer["connect"]>[0],
    );
  });

  afterEach(async () => {
    await server.close();
  });

  test("initialize returns correct protocol version", async () => {
    transport.receive(
      request(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    const initRes = findResponse(transport, 1);
    expect(initRes).toBeDefined();
    expect(initRes.result!.protocolVersion).toBe("2024-11-05");
    expect(initRes.result!.serverInfo!.name).toBe("test-server");
    expect(initRes.result!.capabilities).toBeDefined();
  });

  test("tools/list returns tools with schema", async () => {
    transport.receive(request(2, "tools/list"));

    await new Promise((r) => setTimeout(r, 50));

    const res = findResponse(transport, 2);
    expect(res).toBeDefined();
    expect(res.result!.tools).toBeInstanceOf(Array);
    expect(res.result!.tools!.length).toBeGreaterThan(0);
    const tool = res.result!.tools![0];
    expect(tool.name).toBe("test-tool");
    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema.type).toBe("object");
  });

  test("tools/call executes tool handler", async () => {
    transport.receive(
      request(3, "tools/call", {
        name: "test-tool",
        arguments: { message: "hello" },
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    const res = findResponse(transport, 3);
    expect(res).toBeDefined();
    expect(res.result!.content![0].text).toBe("Echo: hello");
  });

  test("resources/list returns resources", async () => {
    transport.receive(request(4, "resources/list"));

    await new Promise((r) => setTimeout(r, 50));

    const res = findResponse(transport, 4);
    expect(res).toBeDefined();
    expect(res.result!.resources).toBeInstanceOf(Array);
    expect(res.result!.resources!.length).toBeGreaterThan(0);
    expect(res.result!.resources![0].uri).toBe("test://data");
  });

  test("prompts/list returns prompts", async () => {
    transport.receive(request(5, "prompts/list"));

    await new Promise((r) => setTimeout(r, 50));

    const res = findResponse(transport, 5);
    expect(res).toBeDefined();
    expect(res.result!.prompts).toBeInstanceOf(Array);
    expect(res.result!.prompts!.length).toBeGreaterThan(0);
    expect(res.result!.prompts![0].name).toBe("test-prompt");
  });

  test("resource template lists matching resources", async () => {
    const rt = server.registerResource(
      "Templated",
      new ResourceTemplate("template://{category}", {
        list: async () => ({
          resources: [
            {
              uri: "template://foo",
              name: "Foo",
              mimeType: "application/json",
            },
            {
              uri: "template://bar",
              name: "Bar",
              mimeType: "application/json",
            },
          ],
        }),
      }),
      { description: "A templated resource", mimeType: "application/json" },
      async (uri, variables) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ category: variables.category }),
          },
        ],
      }),
    );

    server.sendResourceListChanged();
    transport.receive(request(6, "resources/list"));

    await new Promise((r) => setTimeout(r, 50));

    const res = findResponse(transport, 6);
    expect(res).toBeDefined();
    expect(res.result!.resources!.length).toBeGreaterThanOrEqual(2);

    rt.remove();
  });

  test("unknown method returns error", async () => {
    transport.receive(request(6, "unknown/method"));

    await new Promise((r) => setTimeout(r, 50));

    const res = findResponse(transport, 6);
    expect(res).toBeDefined();
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32601);
  });
});
