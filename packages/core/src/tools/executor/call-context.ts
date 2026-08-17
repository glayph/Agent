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
 * Coverage: currently set by the direct tool-call route
 * (POST /tools/:name/call) and the chat routes (POST /chat, POST
 * /api/chat) in packages/core/src/api/index.ts, using the request's real
 * client IP (see isLoopbackAddress in @miki/config/security) to decide
 * local vs. remote. NOT yet set for MCP-driven tool calls (the MCP session
 * manager's executeTool callback has no per-call request context available
 * without deeper changes to that subsystem) or for channel-driven calls
 * (Discord/Telegram/etc. invoke the orchestrator in-process, not through
 * an HTTP route). getCallOrigin() returns undefined in those cases;
 * callers should treat that as "local" (fail-open, preserving existing
 * behavior for paths this fix does not yet cover) rather than silently
 * blocking execution for code paths that were never audited for this.
 */

export type CallOrigin = "local" | "remote";

interface CallContext {
  origin: CallOrigin;
}

const callContextStorage = new AsyncLocalStorage<CallContext>();

export function runWithCallOrigin<T>(origin: CallOrigin, fn: () => T): T {
  return callContextStorage.run({ origin }, fn);
}

/** Returns the origin set by the nearest enclosing runWithCallOrigin call,
 * or undefined if no request handler in the current call chain has set one
 * (see "Coverage" above). */
export function getCallOrigin(): CallOrigin | undefined {
  return callContextStorage.getStore()?.origin;
}
