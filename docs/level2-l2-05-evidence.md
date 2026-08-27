# L2-05 Web UI Evidence — System Information

The visible run header used `llama.cpp / llama.cpp/gemma-4-E2B-it_Q4_0`.

Agent Miki was instructed to run exactly `printf 'OS='; uname -s; printf 'KERNEL='; uname -r; printf 'NODE='; node --version` without modifying files. The Web UI reported: operating system `Linux`, kernel `6.1.102`, and Node.js `v22.13.0`. The command completed successfully in the Web UI.

Verdict: **100% verified** for the defined system-information query and report scope.
