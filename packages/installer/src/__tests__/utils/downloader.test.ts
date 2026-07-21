import * as http from "http";
import type { AddressInfo } from "net";
import { downloadText } from "../../utils/downloader";

async function withServer(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe("downloader", () => {
  it("rejects HTTP URLs by default", async () => {
    await expect(
      downloadText("http://127.0.0.1:1", undefined, 1),
    ).rejects.toThrow(/non-HTTPS/);
  });

  it("follows bounded relative redirects when HTTP is explicitly allowed", async () => {
    await withServer(
      (req, res) => {
        if (req.url === "/redirect") {
          res.writeHead(302, { Location: "/final" });
          res.end();
          return;
        }
        res.end("ok");
      },
      async (baseUrl) => {
        await expect(
          downloadText(
            `${baseUrl}/redirect`,
            { allowHttp: true, maxRedirects: 1 },
            1,
          ),
        ).resolves.toBe("ok");
      },
    );
  });

  it("rejects responses over the configured byte limit", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Length": "10" });
        res.end("0123456789");
      },
      async (baseUrl) => {
        await expect(
          downloadText(`${baseUrl}/large`, { allowHttp: true, maxBytes: 5 }, 1),
        ).rejects.toThrow(/exceeds maximum size/);
      },
    );
  });
});
