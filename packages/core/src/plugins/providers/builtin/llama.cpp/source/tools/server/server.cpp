#include "server-context.h"
#include "server-http.h"

#include "arg.h"
#include "build-info.h"
#include "common.h"
#include "fit.h"
#include "llama.h"
#include "log.h"

#include <atomic>
#include <clocale>
#include <exception>
#include <signal.h>

#if defined(_WIN32)
#include <windows.h>
#endif

static std::function<void(int)> shutdown_handler;
static std::atomic_flag is_terminating = ATOMIC_FLAG_INIT;

static inline void signal_handler(int signal) {
    if (is_terminating.test_and_set()) {
        fprintf(stderr, "Received second interrupt, terminating immediately.\n");
        exit(1);
    }
    shutdown_handler(signal);
}

struct server_run_opts {
    bool install_signal_handlers = true;
};

int llama_server(int argc, char ** argv);
void llama_server_terminate();

void llama_server_terminate() {
    if (shutdown_handler) {
        shutdown_handler(0);
    }
}

static server_http_context::handler_t ex_wrapper(server_http_context::handler_t func) {
    return [func = std::move(func)](const server_http_req & req) -> server_http_res_ptr {
        std::string message;
        error_type error;
        try {
            return func(req);
        } catch (const std::invalid_argument & e) {
            error = ERROR_TYPE_INVALID_REQUEST;
            message = e.what();
        } catch (const common_json_error & e) {
            error = ERROR_TYPE_INVALID_REQUEST;
            message = e.what();
        } catch (const std::exception & e) {
            error = ERROR_TYPE_SERVER;
            message = e.what();
        } catch (...) {
            error = ERROR_TYPE_SERVER;
            message = "unknown error";
        }

        auto res = std::make_unique<server_http_res>();
        res->status = 500;
        try {
            json error_data = format_error_response(message, error);
            res->status = json_value(error_data, "code", 500);
            res->data = safe_json_to_str({{ "error", error_data }});
            SRV_WRN("got exception: %s\n", res->data.c_str());
        } catch (const std::exception & e) {
            SRV_ERR("got another exception: %s | while handling exception: %s\n", e.what(), message.c_str());
            res->data = "Internal Server Error";
        }
        return res;
    };
}

static bool server_prepare_params(common_params & params) {
    if (params.model.path.empty()) {
        SRV_ERR("%s", "A local GGUF model is required. Pass its path with --model.\n");
        return false;
    }

    // Agent-Miki uses a single text-only GGUF model. Do not load an external
    // multimodal projector or enable embeddings through this runtime server.
    if (!params.mmproj.path.empty() || !params.mmproj.url.empty() ||
        !params.mmproj.hf_repo.empty() || !params.mmproj.docker_repo.empty() ||
        !params.image.empty()) {
        SRV_ERR("%s", "Agent-Miki runtime supports text-only GGUF models; multimodal projector and image inputs are disabled.\n");
        return false;
    }
    if (params.embedding) {
        SRV_ERR("%s", "Agent-Miki runtime exposes chat inference only; embedding mode is disabled.\n");
        return false;
    }

    if (params.n_parallel < 0) {
        SRV_TRC("%s", "n_parallel is set to auto, using n_parallel = 4 and kv_unified = true\n");
        params.n_parallel = 4;
        params.kv_unified = true;
    }

    const bool ctx_pool_auto_sized = params.kv_unified_per_slot > 0 &&
                                     params.n_ctx == 0 &&
                                     (uint32_t) params.fit_params_min_ctx != UINT32_MAX;
    if (ctx_pool_auto_sized) {
        params.n_ctx = params.n_parallel * params.kv_unified_per_slot;
        SRV_INF("--kv-unified-per-slot: sizing KV pool to n_parallel * kv_unified_per_slot = %d * %d = %d\n",
                params.n_parallel, params.kv_unified_per_slot, params.n_ctx);
    }

    const auto model_name = params.model.get_name();
    if (params.model_alias.empty() && !model_name.empty()) {
        params.model_alias.insert(model_name);
    }
    return true;
}

static void server_register_routes(server_http_context & ctx_http, server_routes & routes) {
    ctx_http.get ("/health",              ex_wrapper(routes.get_health));
    ctx_http.get ("/v1/health",           ex_wrapper(routes.get_health));
    ctx_http.get ("/metrics",             ex_wrapper(routes.get_metrics));
    ctx_http.get ("/props",               ex_wrapper(routes.get_props));
    ctx_http.get ("/models",              ex_wrapper(routes.get_models));
    ctx_http.get ("/v1/models",           ex_wrapper(routes.get_models));
    ctx_http.post("/chat/completions",    ex_wrapper(routes.post_chat_completions));
    ctx_http.post("/v1/chat/completions", ex_wrapper(routes.post_chat_completions));
}

static void server_warn_security(const common_params & params) {
    if (params.cors_origins == "*" && params.api_keys.empty()) {
        SRV_WRN("%s", "security: no API key is set and CORS allows all origins (configure --api-key or --cors-origins)\n");
    }
}

static void server_install_signal_handlers() {
#if defined (__unix__) || (defined (__APPLE__) && defined (__MACH__))
    struct sigaction sigint_action;
    sigint_action.sa_handler = signal_handler;
    sigemptyset (&sigint_action.sa_mask);
    sigint_action.sa_flags = 0;
    sigaction(SIGINT, &sigint_action, NULL);
    sigaction(SIGTERM, &sigint_action, NULL);
#elif defined (_WIN32)
    auto console_ctrl_handler = +[](DWORD ctrl_type) -> BOOL {
        return (ctrl_type == CTRL_C_EVENT) ? (signal_handler(SIGINT), true) : false;
    };
    SetConsoleCtrlHandler(reinterpret_cast<PHANDLER_ROUTINE>(console_ctrl_handler), true);
#endif
}

static void server_on_listening(server_http_context & ctx_http) {
    for (const auto & address : ctx_http.listening_addresses) {
        SRV_INF("listening on %s\n", address.c_str());
    }
}

static int server_run_single_model(common_params & params, const server_run_opts & opts) {
    common_params_print_info(params, true);
    if (!server_prepare_params(params)) {
        return 1;
    }

    server_context ctx_server;
    server_routes routes(params, ctx_server);

    server_http_context ctx_http;
    if (!ctx_http.init(params)) {
        SRV_ERR("%s", "failed to initialize HTTP server\n");
        return 1;
    }

    server_register_routes(ctx_http, routes);
    server_warn_security(params);

    auto clean_up = [&ctx_http, &ctx_server]() {
        SRV_INF("%s: cleaning up before exit...\n", __func__);
        ctx_http.stop();
        ctx_server.terminate();
        llama_backend_free();
    };

    // Start HTTP first so Miki can poll readiness while the GGUF model loads.
    if (!ctx_http.start()) {
        clean_up();
        SRV_ERR("%s", "exiting due to HTTP server error\n");
        return 1;
    }

    if (!ctx_server.load_model(params)) {
        clean_up();
        ctx_http.join();
        SRV_ERR("%s", "exiting due to model loading error\n");
        return 1;
    }

    routes.update_meta(ctx_server);
    ctx_http.is_ready.store(true);
    SRV_INF("%s", "model loaded\n");

    shutdown_handler = [&](int) {
        ctx_server.terminate();
    };

    if (opts.install_signal_handlers) {
        server_install_signal_handlers();
    }

    server_on_listening(ctx_http);
    ctx_server.start_loop();

    clean_up();
    ctx_http.join();

    auto * ll_ctx = ctx_server.get_llama_context();
    if (ll_ctx != nullptr) {
        common_memory_breakdown_print(ll_ctx);
    }
    return 0;
}

int llama_server(int argc, char ** argv) {
    std::setlocale(LC_NUMERIC, "C");
#ifndef _WIN32
    signal(SIGPIPE, SIG_IGN);
#endif

    common_params params;
    common_init();
    if (!common_params_parse(argc, argv, params, LLAMA_EXAMPLE_SERVER)) {
        return 1;
    }

    SRV_INF("%s", "initializing single-model Agent-Miki runtime...\n");
    llama_backend_init();
    llama_numa_init(params.numa);

    const int result = server_run_single_model(params, server_run_opts{});
    common_log_flush(common_log_main());
    return result;
}
