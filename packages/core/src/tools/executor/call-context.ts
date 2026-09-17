import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Caller-origin context for tool execution (#94: "Exec Allow Remote" was
 * saved to config/tools.yaml's runtime.exec.allow_remote but nothing ever
 * checked it before running a shell command).
 *
 * This is threaded via AsyncLocalStorage rather than an explicit function
 * parameter because the call chain that ultimately reaches
 * ShellExecutor.runShell passes through packages/core/src/agent.ts, which
 * is a protected file in this project and cannot be edited. The LLM-driven
 * tool-call path (agent.ts's _executeToolInvocation ->
 * ToolRegistry.executeToolStructured) has no session/origin field in its
 * options today, and that call site can't be changed to add one.
 * AsyncLocalStorage lets the outermost request handlers -- the only code
 * that actually knows the caller's network origin -- establish this
 * context once per request; it then survives every intervening async call
 * automatically, agent.ts included, with zero changes to any function
 * signature in between.
 *
 * Coverage: HTTP tool/chat routes, Telegram turns, and MCP tool execution now
 * establish a caller context. HTTP routes classify local vs. remote using the
 * request's real client IP (see isLoopbackAddress in @miki/config/security),
 * while Telegram and MCP are explicitly remote because they arrive through an
 * external channel/session. Other in-process channels still have no caller
 * context and therefore retain the legacy undefined-origin behavior until they
 * are audited and wrapped.
 */

export type CallOrigin = "local" | "remote";
export type CallSource = "web_ui" | "telegram" | "mcp" | "local_cli" | "system";

export interface CallContext {
  origin: CallOrigin;
  source?: CallSource;
  actor?: string;
  requestId?: string;
}

const callContextStorage = new AsyncLocalStorage<CallContext>();

export function runWithCallOrigin<T>(origin: CallOrigin, fn: () => T): T {
  return runWithCallContext({ origin }, fn);
}

export function runWithCallContext<T>(context: CallContext, fn: () => T): T {
  return callContextStorage.run(context, fn);
}

/** Returns the full caller context, if one was established by the enclosing request. */
export function getCallContext(): CallContext | undefined {
  return callContextStorage.getStore();
}

/** Returns the origin set by the nearest enclosing call context,
 * or undefined if no request handler in the current call chain has set one
 * (see "Coverage" above). */
export function getCallOrigin(): CallOrigin | undefined {
  return getCallContext()?.origin;
}
