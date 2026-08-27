# Level 1 — File and Folder Evidence

A fresh authenticated Web UI session showed `gemma-4-e2b` selected and the run header `llama.cpp / llama.cpp/gemma-4-E2B-it-Q4_0`. The prompt asked Miki to use file and shell tools to create exactly two files in a new folder, read them, list the folder, and search for a term.

The visible Web UI response was: `I will create and verify the source and notes files in the new folder. tool_code:`. No file or shell tool event was shown, and independent workspace inspection found no `level1-files` folder. Therefore L1-06 File পড়া, L1-07 File তৈরি, L1-08 File edit (not attempted in this run), L1-09 Folder তৈরি/পরিচালনা, and L1-10 Text search were not 100% verified. The run demonstrates intent/prose but not executable tool completion.

The likely technical cause is a Gemma/llama.cpp response using `tool_code` in assistant content instead of structured `tool_calls` under the full Miki tool schema. A minimal direct Gemma endpoint probe with one function schema returned a valid structured tool call, so this is an agent prompt/adapter/tool-surface integration issue, not proof that the GGUF server is unavailable.
