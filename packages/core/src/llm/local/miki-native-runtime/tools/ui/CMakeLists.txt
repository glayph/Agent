# Miki local runtime intentionally exposes no embedded web interface.
# The server still links this small compatibility target, so the target remains
# available while all UI asset generation and frontend tooling stay out of the
# distributable native runtime.

add_library(llama-ui STATIC ui-headless.cpp)
target_compile_features(llama-ui PRIVATE cxx_std_17)
target_include_directories(llama-ui PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
