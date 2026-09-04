# L2-04 Web UI Evidence — Process Termination

Two Web UI attempts were made with the local Gemma model identity visible in the run header. Each instructed Agent Miki to start only a disposable `sleep` background process, terminate it with `SIGTERM`, wait for it, and report exact stdout and exit status without touching pre-existing processes.

The first attempt produced a planning/feedback-style message and no shell result. The second concise retry also produced no shell result before the run ended. The required `STARTED_PID`, `WAIT_STATUS`, and completion marker were not returned in the Web UI.

Verdict: **0% verified / failed** for strict process-control evidence. The test cannot establish that Miki successfully stopped a process because the Web UI tool trace is absent.
