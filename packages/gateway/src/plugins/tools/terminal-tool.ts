/** Gateway host adapter for the Core terminal tools. Process ownership stays in Gateway. */
import { ProcessManager } from "../../runtime/process-manager.js"
import {
  createTerminalTools as createCoreTerminalTools,
  createTerminalTool as createCoreTerminalTool,
  type TerminalToolOptions as CoreTerminalToolOptions,
} from "@miki/core/plugins/tools"

export {
  blockedReason,
  describeProcess,
  resolveCodingAgent,
  testCommandPatterns,
  terminalSafeMode,
} from "@miki/core/plugins/tools"
export type { CodingAgentCommand } from "@miki/core/plugins/tools"

export type TerminalToolOptions = Omit<CoreTerminalToolOptions, "processes"> & {
  processes?: ProcessManager
}

function withProcessManager(options: TerminalToolOptions): CoreTerminalToolOptions {
  return { ...options, processes: options.processes ?? new ProcessManager() }
}

export function createTerminalTools(options: TerminalToolOptions) {
  return createCoreTerminalTools(withProcessManager(options))
}

export function createTerminalTool(options: TerminalToolOptions) {
  return createCoreTerminalTool(withProcessManager(options))
}
