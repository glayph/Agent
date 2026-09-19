/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "http-proxy-middleware" {
  import type { RequestHandler } from "express";
  import type { IncomingMessage, ServerResponse } from "http";
  import type { Options as HttpProxyOptions } from "http-proxy";

  interface Filter {
    (pathname: string, req: IncomingMessage): boolean;
  }

  interface LogProvider {
    log: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  }

  interface Options extends HttpProxyOptions {
    pathFilter?: string | string[] | Filter;
    pathRewrite?:
      | { [regexp: string]: string }
      | ((path: string, req: IncomingMessage) => string);
    router?: { [host: string]: string } | ((req: IncomingMessage) => string);
    logLevel?: "debug" | "info" | "warn" | "error" | "silent";
    logProvider?: (provider: LogProvider) => LogProvider;
    on?: {
      proxyReq?: (
        proxyReq: any,
        req: IncomingMessage,
        res: ServerResponse,
      ) => void;
      proxyRes?: (
        proxyRes: IncomingMessage,
        req: IncomingMessage,
        res: ServerResponse,
      ) => void;
      error?: (err: Error, req: IncomingMessage, res: ServerResponse) => void;
    };
  }

  export function createProxyMiddleware(options: Options): RequestHandler;
  export function createProxyMiddleware(
    options?: string | Options,
  ): RequestHandler;
  export { Options };
}

declare module "http-proxy-middleware/dist/context-matcher" {
  export function match(context: unknown, uri: string, req: unknown): boolean;
}
