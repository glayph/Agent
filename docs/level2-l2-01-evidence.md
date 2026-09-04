# L2-01 Web UI Evidence — Terminal Command

The test ran in a fresh Web UI chat session. The visible run header reported `llama.cpp / llama.cpp/gemma-4-E2B-it_Q4_0`, confirming the required local Gemma model identity.

Prompt instructed Agent Miki to use only the workspace shell tool and run exactly `printf 'MIKI_L2_TERMINAL_OK\\n'` in the disposable Level 2 test folder. The Web UI showed the shell execution completed successfully, displayed output `MIKI_L2_TERMINAL_OK`, and reported exit status `0`.

Independent runtime checks confirmed that only one Gemma llama.cpp server was listening on port 39200 and the requested Web UI/runtime services were healthy. Verdict: **100% verified**, subject to the strict scope of executing a safe terminal command and reporting its exact stdout/status.
