# Level 2 — Computer Task Evidence

A fresh authenticated Web UI session visibly used `gemma-4-e2b` and showed the run header `llama.cpp / llama.cpp/gemma-4-E2B-it_Q4_0`. The prompt explicitly required the shell tool to run exactly `printf 'Miki-shell-ok\n'` and report stdout and exit status.

The visible result was: `I will run the specified shell command to report the output. tool_code:`. No shell tool event or command output was shown. Therefore L2-01 Terminal command চালানো is not 100% verified. The remaining L2 items have not yet received a complete positive Web UI execution trace and must not be marked as 100% from this run.

The local llama.cpp logs showed normal Gemma inference completion, but the answer contained prose/tool_code rather than an executable structured tool call. This is a separate agent/tool-call integration limitation from server readiness.
