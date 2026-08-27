# L2-03 Web UI Evidence — Process Discovery

The visible Web UI run header reported `llama.cpp / llama.cpp/gemma-4-E2B-it_Q4_0`.

Agent Miki was instructed to run exactly `ps -C llama-server -o pid=,comm=,args=` without modifying or stopping any process. The Web UI reported that the command ran successfully and showed PID `20146` with the `llama-server` command and Gemma model path. Independent runtime inspection matched PID `20146` as the single Gemma llama.cpp process.

The visible final prose did not explicitly expose the shell exit-status number, even though it said the command ran successfully. Under the strict matrix, this is **attempted, but not 100% verified** because exact exit-status evidence was required.
