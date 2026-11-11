# Agent-Miki runtime-only build graph.
# Build only the native inference server and its internal shared-context compatibility dependency.
find_package(Threads REQUIRED)
llama_add_compile_flags()

if (EMSCRIPTEN)
    message(FATAL_ERROR "The Agent-Miki llama-server runtime does not support Emscripten builds")
endif()

if (NOT LLAMA_BUILD_SERVER)
    message(FATAL_ERROR "Agent-Miki llama.cpp is configured for the llama-server runtime only")
endif()

# The current upstream server-context translation unit still references MTMD types.
# Keep it as a private static dependency only; Agent-Miki rejects all multimodal inputs
# and does not register image/audio/video routes or ship MTMD sample assets.
if (LLAMA_BUILD_MTMD)
    add_subdirectory(mtmd)
endif()
add_subdirectory(server)
