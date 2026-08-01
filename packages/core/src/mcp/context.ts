import { AsyncLocalStorage } from "async_hooks";

export const mcpSessionStorage = new AsyncLocalStorage<string>();

export function currentMcpSessionId(): string {
  return mcpSessionStorage.getStore() || "default";
}
