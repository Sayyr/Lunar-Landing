// SELENE science service entry point: `selene-science [--host 127.0.0.1] [--port 8000]`.
// Reads SELENE_KERNEL_DIR for the (future) SPICE provider.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include <httplib.h>

#include "app.hpp"

int main(int argc, char** argv) {
    std::string host = "127.0.0.1";
    int port = 8000;
    for (int i = 1; i < argc; ++i) {
        if (!std::strcmp(argv[i], "--host") && i + 1 < argc) {
            host = argv[++i];
        } else if (!std::strcmp(argv[i], "--port") && i + 1 < argc) {
            port = std::atoi(argv[++i]);
        } else {
            std::fprintf(stderr, "usage: %s [--host HOST] [--port PORT]\n", argv[0]);
            return 2;
        }
    }

    const char* kernel_dir = std::getenv("SELENE_KERNEL_DIR");
    const selene::App app(kernel_dir && *kernel_dir ? std::optional<std::filesystem::path>(kernel_dir)
                                                    : std::nullopt);

    httplib::Server server;
    server.set_payload_max_length(1 << 20);
    // Handlers run on httplib's worker thread pool; App is immutable and thread-safe.
    auto handler = [&app](const httplib::Request& req, httplib::Response& res) {
        selene::HttpResponse r = app.handle(req.method, req.path, req.body);
        res.status = r.status;
        res.set_content(r.body.dump(), "application/json");
    };
    server.Get(".*", handler);
    server.Post(".*", handler);
    server.set_logger([](const httplib::Request& req, const httplib::Response& res) {
        std::printf("%s %s %d\n", req.method.c_str(), req.path.c_str(), res.status);
        std::fflush(stdout);
    });

    std::printf("selene-science %s listening on http://%s:%d\n", selene::VERSION, host.c_str(), port);
    std::fflush(stdout);
    if (!server.listen(host, port)) {
        std::fprintf(stderr, "failed to listen on %s:%d\n", host.c_str(), port);
        return 1;
    }
    return 0;
}
