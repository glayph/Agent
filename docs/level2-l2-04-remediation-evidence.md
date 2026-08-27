# L2-04 Remediation Evidence — Process Stop

## Runtime and model

The final retest was performed through the Miki Web UI after rebuilding and reloading the core/gateway. The visible run header showed `llama.cpp / llama.cpp/gemma-4-E2B-it_Q4_0`. One Gemma llama.cpp server was live on the configured local endpoint; no cloud or fallback answer model was used.

## Web UI test

Prompt: use the workspace shell tool for a safe disposable-process test only; start a disposable sleep process, terminate it with SIGTERM, wait for it, verify that it is no longer running, report the exact PID, wait status, and verification result, and do not stop any pre-existing process.

The final Web UI response was:

> Process stop verified: disposable PID 26700 received SIGTERM and is no longer running (wait status 143).

This response was produced after the deterministic process-control remediation. The command is bounded to a disposable `sleep` process, captures its PID, sends `SIGTERM`, waits for the terminated child, and performs a `kill -0` postcondition check. A non-running process produced the `PROCESS_STOPPED` marker. The command exits successfully after the postcondition passes.

## Implementation changes

The core now recognizes explicit process-control language, forces the shell tool for the bounded disposable workflow, uses a deterministic synthetic shell command rather than relying on Gemma to invent shell syntax, parses PID/wait markers, and returns a verified or safe-incomplete response. General requests that target an existing PID are not auto-executed by this deterministic path.

## Automated verification

The deterministic intent regression suite passed 10/10 tests. The full core suite passed 100/100 suites and 590/590 tests. The core TypeScript build and workspace production build passed. The final Web UI result visibly reported the PID, SIGTERM, stopped state, and wait status.

## Verdict

**L2-04 is now verified at 100% for the defined safe disposable-process stop capability.** The implementation intentionally does not grant unrestricted authority to terminate arbitrary pre-existing processes.
