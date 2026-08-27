# L2-06 Web UI Evidence — CPU/RAM/Disk Inspection

The visible run header used `llama.cpp / llama.cpp/gemma-4-E2B-it_Q4_0` and the agent was instructed to use only the workspace shell tool for a read-only query.

The exact query requested CPU core count, RAM in MB, and root disk free/total values. The Web UI did not return the shell result. After the configured 180000 ms local timeout, it displayed:

`[Local AI timeout] llama.cpp did not finish within 180000ms. The request was cancelled; the usual cause is a CPU-bound local model or an oversized prompt/tool context.`

Verdict: **attempted, but not 100% verified**. No resource values were accepted because the required Web UI result was absent. This also provides a fresh reproduction of the remaining local Gemma latency limitation for a multi-command/pipeline prompt, despite the direct tiny completion probe being healthy.
