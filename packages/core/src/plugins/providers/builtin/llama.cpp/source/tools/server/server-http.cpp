#include "common.h"
#include "http.h"
#include "server-http.h"
#include "server-common.h"

#include <cpp-httplib/httplib.h>

#include <functional>
#include <future>
#include <memory>
#include <string>
#include <thread>
#include <mutex>

//
// HTTP implementation using cpp-httplib
//

class server_http_context::Impl {
public:
    std::vector<std::unique_ptr<httplib::Server>> servers;
    std::vector<std::string> hosts;
    std::vector<std::thread> threads; // one thread per listener
    std::unique_ptr<httplib::ThreadPool> pool; // single pool shared among all listeners
    int n_threads_http = 0;
};

class server_http_task_queue : public httplib::TaskQueue {
    httplib::ThreadPool & pool;
public:
    explicit server_http_task_queue(httplib::ThreadPool & pool) : pool(pool) {}
    bool enqueue(std::function<void()> fn) override { return pool.enqueue(std::move(fn)); }
    // note: must call join() to drain the pool
    void shutdown() override { /* no-op */ }
};

server_http_context::server_http_context()
    : pimpl(std::make_unique<Impl>())
{}

server_http_context::~server_http_context() {
    // just in case any exit paths that forget to call join()
    try {
        stop();
        join();
    } catch (const std::exception & e) {
        SRV_ERR("failed to stop HTTP server: %s\n", e.what());
    } catch (...) {
        SRV_ERR("%s", "failed to stop HTTP server\n");
    }
}

static void log_server_request(const httplib::Request & req, const httplib::Response & res) {
    // skip logging requests that are regularly sent, to avoid log spam
    if (req.path == "/health"
        || req.path == "/v1/health"
        || req.path == "/models"
        || req.path == "/v1/models"
        || req.path == "/props"
        || req.path == "/metrics"
    ) {
        return;
    }

    // reminder: this function is not covered by httplib's exception handler; if someone does more complicated stuff, think about wrapping it in try-catch

    SRV_TRC("done request: %s %s %s %d\n", req.method.c_str(), req.path.c_str(), req.remote_addr.c_str(), res.status);

    SRV_DBG("request:  %s\n", req.body.c_str());
    SRV_DBG("response: %s\n", res.body.c_str());
}

// returns true if the Origin header value's host is localhost / 127.0.0.1 / ::1 (any port)
static bool origin_is_localhost(const std::string & origin) {
    try {
        const std::string host = common_http_parse_url(origin).host;
        return host == "localhost" || host == "127.0.0.1" || host == "::1";
    } catch (const std::exception &) {
        return false;
    }
}

bool server_http_context::init(const common_params & params) {
    path_prefix = params.api_prefix;
    port = params.port;

    pimpl->hosts = params.hostnames;
    size_t n_tcp_hosts = 0;
    for (const auto & host : pimpl->hosts) {
        if (!string_ends_with(host, ".sock")) {
            n_tcp_hosts++;
        }
    }
    if (port == 0 && n_tcp_hosts > 1) {
        SRV_ERR("%s", "--port 0 is not supported with multiple TCP addresses\n");
        return false;
    }
    for (size_t i = 0; i < pimpl->hosts.size(); ++i) {
        pimpl->servers.emplace_back();
        if (!init_listener(params)) {
            return false;
        }
        // with multiple TCP addresses, [::] must not also claim 0.0.0.0
        if (n_tcp_hosts > 1) {
            pimpl->servers.back()->set_ipv6_v6only(true);
        }
    }

    pimpl->n_threads_http = params.n_threads_http;
    if (pimpl->n_threads_http < 1) {
        // Reserve threads for metrics and health requests.
        pimpl->n_threads_http = std::max(params.n_parallel + 4, static_cast<int32_t>(std::thread::hardware_concurrency() - 1));
    }
    SRV_TRC("using %d threads for HTTP server\n", pimpl->n_threads_http);
    return true;
}

bool server_http_context::init_listener(const common_params & params) {
    auto & srv = pimpl->servers.back();

#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
    if (!params.ssl_file_key.empty() && !params.ssl_file_cert.empty()) {
        SRV_TRC("running with SSL: key = %s, cert = %s\n", params.ssl_file_key.c_str(), params.ssl_file_cert.c_str());
        srv = std::make_unique<httplib::SSLServer>(
            params.ssl_file_cert.c_str(), params.ssl_file_key.c_str()
        );
        is_ssl = true;
    } else {
        SRV_TRC("%s", "running without SSL\n");
        srv = std::make_unique<httplib::Server>();
    }
#else
    if (params.ssl_file_key != "" && params.ssl_file_cert != "") {
        SRV_ERR("%s", "the server is built without SSL support\n");
        return false;
    }
    srv.reset(new httplib::Server());
#endif

    srv->set_default_headers({{"Server", "llama.cpp"}});
    // srv->set_logger(log_server_request); // TODO @ngxson : this is too spamy, no very useful; improve it in the future
    srv->set_exception_handler([](const httplib::Request &, httplib::Response & res, const std::exception_ptr & ep) {
        // this is fail-safe; exceptions should already handled by `ex_wrapper`

        std::string message;
        try {
            std::rethrow_exception(ep);
        } catch (const std::exception & e) {
            message = e.what();
        } catch (...) {
            message = "Unknown Exception";
        }

        res.status = 500;
        res.set_content(message, "text/plain");
        SRV_ERR("got exception: %s\n", message.c_str());
    });

    srv->set_error_handler([](const httplib::Request &, httplib::Response & res) {
        if (res.status == 404) {
            res.set_content(
                safe_json_to_str(json {
                    {"error", {
                        {"message", "File Not Found"},
                        {"type", "not_found_error"},
                        {"code", 404}
                    }}
                }),
                "application/json; charset=utf-8"
            );
        }
        // for other error codes, we skip processing here because it's already done by res->error()
    });

    // set timeouts and change hostname and port
    srv->set_read_timeout (params.timeout_read);
    srv->set_write_timeout(params.timeout_write);
    srv->set_socket_options([reuse_port = params.reuse_port](const socket_t sock) {
        httplib::set_socket_opt(sock, SOL_SOCKET, SO_REUSEADDR, 1);
        if (reuse_port) {
#ifdef SO_REUSEPORT
            httplib::set_socket_opt(sock, SOL_SOCKET, SO_REUSEPORT, 1);
#else
            SRV_WRN("%s", "SO_REUSEPORT is not supported\n");
#endif
        }
    });

    if (params.api_keys.size() == 1) {
        const auto key = params.api_keys[0];
        const std::string substr = key.substr(std::max(static_cast<int>(key.length() - 4), 0));
        SRV_TRC("api_keys: ****%s\n", substr.c_str());
    } else if (params.api_keys.size() > 1) {
        SRV_TRC("api_keys: %zu keys loaded\n", params.api_keys.size());
    }

    //
    // Middlewares
    //

    // Only health probes are public before model initialization.
    static const std::unordered_set<std::string> get_public_endpoints {
        "/health",
        "/v1/health",
    };

    auto middleware_validate_api_key = [api_keys = params.api_keys](const httplib::Request & req, httplib::Response & res) {
        // If API key is not set, skip validation
        if (api_keys.empty()) {
            return true;
        }

        // Health probes are public; all inference/model APIs use the configured API key.
        if (get_public_endpoints.count(req.path)) {
            return true;
        }

        // Check for API key in the Authorization header
        std::string req_api_key = req.get_header_value("Authorization");
        if (req_api_key.empty()) {
            // retry with anthropic header
            req_api_key = req.get_header_value("X-Api-Key");
        }

        // remove the "Bearer " prefix if needed
        static std::string prefix = "Bearer ";
        if (req_api_key.substr(0, prefix.size()) == prefix) {
            req_api_key = req_api_key.substr(prefix.size());
        }

        // validate the API key
        if (std::find(api_keys.begin(), api_keys.end(), req_api_key) != api_keys.end()) {
            return true; // API key is valid
        }

        // API key is invalid or not provided
        res.status = 401;
        res.set_content(
            safe_json_to_str(json {
                {"error", {
                    {"message", "Invalid API Key"},
                    {"type", "authentication_error"},
                    {"code", 401}
                }}
            }),
            "application/json; charset=utf-8"
        );

        SRV_WRN("%s", "unauthorized: Invalid API Key\n");

        return false;
    };

    auto middleware_server_state = [this](const httplib::Request &, httplib::Response & res) {
        if (!is_ready.load()) {
            // no endpoints are allowed to be accessed when the server is not ready
            // this is to prevent any data races or inconsistent states
            res.status = 503;
            res.set_content(
                safe_json_to_str(json {
                    {"error", {
                        {"message", "Loading model"},
                        {"type", "unavailable_error"},
                        {"code", 503}
                    }}
                }),
                "application/json; charset=utf-8"
            );
            return false;
        }
        return true;
    };

    // register server middlewares
    srv->set_pre_routing_handler([&params, middleware_validate_api_key, middleware_server_state](const httplib::Request & req, httplib::Response & res) {
        if (params.cors_credentials && params.cors_origins == "*") {
            // special case: echo back the Origin header to allow any origin to access the server with credentials
            res.set_header("Access-Control-Allow-Origin", req.get_header_value("Origin"));
        } else if (params.cors_origins == "localhost") {
            // special case: only reflect the Origin header if it is a localhost origin
            std::string origin = req.get_header_value("Origin");
            if (!origin.empty() && origin_is_localhost(origin)) {
                res.set_header("Access-Control-Allow-Origin", origin);
            } else if (!origin.empty()) {
                SRV_WRN("(CORS) skip non-localhost origin: %s\n", origin.c_str());
            }
        } else {
            res.set_header("Access-Control-Allow-Origin", params.cors_origins);
        }
        // If this is OPTIONS request, skip validation because browsers don't include Authorization header
        if (req.method == "OPTIONS") {
            res.set_header("Access-Control-Allow-Credentials", params.cors_credentials ? "true" : "false");
            res.set_header("Access-Control-Allow-Methods",     params.cors_methods);
            res.set_header("Access-Control-Allow-Headers",     params.cors_headers);
            res.set_content("", "text/html"); // blank response, no data
            return httplib::Server::HandlerResponse::Handled; // skip further processing
        }
        if (!middleware_server_state(req, res)) {
            return httplib::Server::HandlerResponse::Handled;
        }
        if (!middleware_validate_api_key(req, res)) {
            return httplib::Server::HandlerResponse::Handled;
        }
        return httplib::Server::HandlerResponse::Unhandled;
    });

    srv->new_task_queue = [this] {
        return new server_http_task_queue(*pimpl->pool);
    };

    return true;
}

bool server_http_context::start() {
    // Bind and listen

    listening_addresses.clear();
    for (size_t i = 0; i < pimpl->servers.size(); ++i) {
        const auto & srv = pimpl->servers[i];
        const auto & host = pimpl->hosts[i];
        const bool is_sock = string_ends_with(host, ".sock");
        bool was_bound;
        if (is_sock) {
            SRV_TRC("%s", "setting address family to AF_UNIX\n");
            srv->set_address_family(AF_UNIX);
            // AF_UNIX ignores the port, but bind_to_port requires a nonzero value.
            was_bound = srv->bind_to_port(host, 8080);
        } else if (port == 0) {
            const auto bound_port = srv->bind_to_any_port(host);
            was_bound = bound_port >= 0;
            if (was_bound) {
                port = bound_port;
            }
        } else {
            was_bound = srv->bind_to_port(host, port);
        }
        if (!was_bound) {
            SRV_ERR("couldn't bind HTTP server socket, hostname: %s, port: %d\n", host.c_str(), port);
            stop();
            listening_addresses.clear();
            return false;
        }
        listening_addresses.push_back(is_sock ? string_format("unix://%s", host.c_str())
                                              : string_format("%s://%s:%d", is_ssl ? "https" : "http", common_http_format_host(host).c_str(), port));
    }

    // n_threads_http fixed threads (always alive), plus up to 1024 dynamic threads destroyed after each request
    // ref: https://github.com/yhirose/cpp-httplib/pull/2368
    pimpl->pool = std::make_unique<httplib::ThreadPool>(pimpl->n_threads_http, pimpl->n_threads_http + 1024);
    for (size_t i = 0; i < pimpl->servers.size(); ++i) {
        const auto & srv = pimpl->servers[i];
        pimpl->threads.emplace_back([srv = srv.get(), addr = listening_addresses[i]] {
            if (!srv->listen_after_bind()) {
                SRV_ERR("listener on %s stopped unexpectedly\n", addr.c_str());
            }
        });
        srv->wait_until_ready();
        if (!srv->is_running()) {
            SRV_ERR("couldn't start HTTP listener on %s\n", listening_addresses[i].c_str());
            stop();
            join();
            listening_addresses.clear();
            return false;
        }
    }
    return true;
}

void server_http_context::stop() const {
    for (const auto & srv : pimpl->servers) {
        if (srv) {
            srv->stop();
        }
    }
}

void server_http_context::join() {
    for (auto & thread : pimpl->threads) {
        if (thread.joinable()) {
            thread.join();
        }
    }
    // Queued requests still refer to their servers until the workers finish.
    if (pimpl->pool) {
        pimpl->pool->shutdown();
        pimpl->pool.reset();
    }
}

static void set_headers(httplib::Response & res, const std::map<std::string, std::string> & headers) {
    for (const auto & [key, value] : headers) {
        res.set_header(key, value);
    }
}

// percent-decode a path component (%XX). path params arrive raw from httplib, unlike query
// params, so a conv id like "conv::model" sent as "conv%3A%3Amodel" must be decoded here to
// match the value the client put in the X-Conversation-Id header
static std::string decode_path_component(const std::string & in) {
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size(); i++) {
        if (in[i] == '%' && i + 2 < in.size()) {
            auto hex = [](char c) -> int {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                return -1;
            };
            int hi = hex(in[i + 1]);
            int lo = hex(in[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out.push_back(char((hi << 4) | lo));
                i += 2;
                continue;
            }
        }
        out.push_back(in[i]);
    }
    return out;
}

static std::map<std::string, std::string> get_params(const httplib::Request & req) {
    std::map<std::string, std::string> params;
    for (const auto & [key, value] : req.params) {
        params[key] = value;
    }
    for (const auto & [key, value] : req.path_params) {
        params[key] = decode_path_component(value);
    }
    return params;
}

static std::map<std::string, std::string> get_headers(const httplib::Request & req) {
    std::map<std::string, std::string> headers;
    for (const auto & [key, value] : req.headers) {
        headers[key] = value;
    }
    return headers;
}

static std::string build_query_string(const httplib::Request & req) {
    std::string qs;
    for (const auto & [key, value] : req.params) {
        if (!qs.empty()) {
            qs += '&';
        }
        qs += httplib::encode_query_component(key) + "=" + httplib::encode_query_component(value);
    }
    return qs;
}

// using unique_ptr for request to allow safe capturing in lambdas
using server_http_req_ptr = std::unique_ptr<server_http_req>;

static void process_handler_response(server_http_req_ptr && request, server_http_res_ptr & response, httplib::Response & res) {
    if (response->is_stream()) {
        res.status = response->status;
        // Tell Nginx to not buffer any streamed response
        response->headers["X-Accel-Buffering"] = "no";
        set_headers(res, response->headers);
        const std::string content_type = response->content_type;
        // convert to shared_ptr as both chunked_content_provider() and on_complete() need to use it
        std::shared_ptr<server_http_req> q_ptr = std::move(request);
        std::shared_ptr<server_http_res> r_ptr = std::move(response);

        const auto chunked_content_provider = [response = r_ptr](size_t, httplib::DataSink & sink) -> bool {
            std::string chunk;
            const bool has_next = response->next(chunk);
            if (!chunk.empty()) {
                if (!sink.write(chunk.data(), chunk.size())) {
                    return false;
                }
                SRV_DBG("http: streamed chunk: %s\n", chunk.c_str());
            }
            if (!has_next) {
                sink.done();
                SRV_DBG("%s", "http: stream ended\n");
            }
            return has_next;
        };
        const auto on_complete = [request = q_ptr, response = r_ptr](bool) mutable {
            response->on_complete();
            response.reset();
            request.reset();
        };
        res.set_chunked_content_provider(content_type, chunked_content_provider, on_complete);
    } else {
        res.status = response->status;
        set_headers(res, response->headers);
        res.set_content(response->data, response->content_type);
        response->on_complete();
    }
}

void server_http_context::get(const std::string & path, const server_http_context::handler_t & handler) const {
    handlers.emplace(path, handler);
    auto callback = [handler](const httplib::Request & req, httplib::Response & res) {
        server_http_req_ptr request = std::make_unique<server_http_req>(server_http_req{
            get_params(req),
            get_headers(req),
            req.path,
            build_query_string(req),
            req.body,
            {},
            req.is_connection_closed
        });
        server_http_res_ptr response = handler(*request);
        process_handler_response(std::move(request), response, res);
    };
    const std::string full_path = path_prefix + path;
    for (const auto & srv : pimpl->servers) {
        srv->Get(full_path, callback);
    }
}

void server_http_context::post(const std::string & path, const server_http_context::handler_t & handler) const {
    handlers.emplace(path, handler);
    auto callback = [handler](const httplib::Request & req, httplib::Response & res) {
        std::string body = req.body;
        std::map<std::string, uploaded_file> files;

        if (req.is_multipart_form_data()) {
            // translate text fields to a JSON object and use it as the body
            json form_json = json::object();
            for (const auto & [key, field] : req.form.fields) {
                if (form_json.contains(key)) {
                    // if the key already exists, convert it to an array
                    if (!form_json[key].is_array()) {
                        json existing_value = form_json[key];
                        form_json[key] = json::array({existing_value});
                    }
                    form_json[key].push_back(field.content);
                } else {
                    form_json[key] = field.content;
                }
            }
            body = form_json.dump();

            // populate files from multipart form
            for (const auto & [key, file] : req.form.files) {
                files[key] = uploaded_file{
                    raw_buffer(file.content.begin(), file.content.end()),
                    file.filename,
                    file.content_type,
                };
            }
        }

        server_http_req_ptr request = std::make_unique<server_http_req>(server_http_req{
            get_params(req),
            get_headers(req),
            req.path,
            build_query_string(req),
            body,
            std::move(files),
            req.is_connection_closed
        });
        server_http_res_ptr response = handler(*request);
        process_handler_response(std::move(request), response, res);
    };
    const std::string full_path = path_prefix + path;
    for (const auto & srv : pimpl->servers) {
        srv->Post(full_path, callback);
    }
}

