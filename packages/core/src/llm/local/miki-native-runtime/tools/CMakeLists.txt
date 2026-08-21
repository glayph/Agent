# Miki local runtime builds only the native server path.
# Optional benchmarks, converters, examples, interactive CLI tools, and web
# assets are intentionally outside the distributable source tree.

find_package(Threads REQUIRED)
llama_add_compile_flags()

add_subdirectory(ui)
add_subdirectory(mtmd)
add_subdirectory(server)
