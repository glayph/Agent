import { pathToFileURL } from "url";

export function rewriteApiProxyPath(p: string): string {
  return `/api${p}`;
}

export function rewriteWebhookProxyPath(p: string): string {
  return p === "/" ? "/webhooks" : `/webhooks${p}`;
}

export function rewriteMcpProxyPath(p: string): string {
  return p === "/" ? "/mcp" : `/mcp${p}`;
}

export function runtimeLoaderArgsFor(
  loaderPath: string,
  exists: (p: string) => boolean,
): string[] {
  if (!exists(loaderPath)) return [];
  const registerSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(pathToFileURL(loaderPath).href)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--import",
    `data:text/javascript,${encodeURIComponent(registerSource)}`,
  ];
}
