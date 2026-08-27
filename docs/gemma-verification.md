
# Gemma model verification

Checked on 2026-08-27. Google’s official Gemma 4 overview lists E2B as an official parameter-size variant and describes Gemma 4 as supporting reasoning, coding, agentic capabilities, and function calling. The official Hugging Face repository `google/gemma-4-E2B` exists and is tagged as an Any-to-Any image-text-to-text Gemma 4 model. The user’s “Gemma 4 E2B” name is therefore valid, although the exact runtime/API identifier still depends on the provider adapter (for example, a Hugging Face/Ollama/llama.cpp variant may use a quantized or instruct-specific name).

Sources:
- https://ai.google.dev/gemma/docs/core
- https://huggingface.co/google/gemma-4-E2B
