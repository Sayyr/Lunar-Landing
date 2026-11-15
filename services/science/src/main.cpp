// SELENE science service entry point: `selene-science [--host 127.0.0.1] [--port 8000]`.
// Reads SELENE_KERNEL_DIR for the SPICE provider, SELENE_DEM_PATH (+ optional SELENE_DEM_LABEL), the
// south-polar DEM for the terrain horizon and the slope check, and, for the slope check elsewhere on
// the Moon (each optional, used in this order after SELENE_DEM_PATH):
//   SELENE_SLDEM_DIR        directory of SLDEM2015 tiles (sldem2015_*_float.img + .lbl), 60S-60N
//   SELENE_SLOPE_DEM_PATHS  ':'-separated further LOLA polar DEM images (e.g. ldem_60s_60m, ldem_60n_60m)
// See scripts/setup-slope-dem.sh.
// POST /trajectory/simulate runs the vecteur-traj executable: SELENE_VECTEUR_TRAJ, else the
// `vecteur-traj` file next to this executable.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

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
    std::shared_ptr<const selene::Dem> dem;
    std::string dem_reason = "SELENE_DEM_PATH not set";
    const char* dem_path = std::getenv("SELENE_DEM_PATH");
    if (dem_path && *dem_path) {
        const char* dem_label = std::getenv("SELENE_DEM_LABEL");
        try {
            dem = selene::Dem::open_pds_auto(dem_path, dem_label && *dem_label
                                                           ? std::optional<std::filesystem::path>(dem_label)
                                                           : std::nullopt);
            const auto& d = dem->info();
            std::printf("DEM %s: %s, %dx%d px at %g m, sha256 %s\n", d.product_id.c_str(), dem_path, d.lines,
                        d.samples, d.proj.scale_m, d.sha256 ? d.sha256->c_str() : "(no SHA256SUMS entry)");
        } catch (const std::exception& e) {
            dem_reason = std::string("SELENE_DEM_PATH unusable: ") + e.what();
            std::fprintf(stderr, "%s\n", dem_reason.c_str());
        }
    }
    std::vector<std::shared_ptr<const selene::Dem>> slope_dems;
    auto add_slope_dem = [&](const char* what, auto open) {
        try {
            auto d = open();
            std::printf("slope DEM %s\n", selene::dem_coverage_label(d->info()).c_str());
            slope_dems.push_back(std::move(d));
        } catch (const std::exception& e) {
            std::fprintf(stderr, "%s unusable: %s\n", what, e.what());  // the service runs without it
        }
    };
    if (const char* dir = std::getenv("SELENE_SLDEM_DIR"); dir && *dir)
        add_slope_dem("SELENE_SLDEM_DIR", [&] { return selene::Dem::open_sldem_dir(dir); });
    if (const char* paths = std::getenv("SELENE_SLOPE_DEM_PATHS"); paths && *paths) {
        std::string all = paths;
        for (std::size_t a = 0; a <= all.size();) {
            const std::size_t b = std::min(all.find(':', a), all.size());
            const std::string p = all.substr(a, b - a);
            if (!p.empty())
                add_slope_dem("SELENE_SLOPE_DEM_PATHS entry", [&] { return selene::Dem::open_pds_auto(p, std::nullopt); });
            a = b + 1;
        }
    }
    if (!dem && !slope_dems.empty()) dem_reason += " (other slope DEMs installed)";
    std::optional<std::filesystem::path> traj_tool;
    if (const char* t = std::getenv("SELENE_VECTEUR_TRAJ"); t && *t) {
        traj_tool = std::filesystem::path(t);
    } else {
        std::error_code ec;
        const auto self = std::filesystem::absolute(argv[0], ec);
        if (!ec && std::filesystem::exists(self.parent_path() / "vecteur-traj")) traj_tool = self.parent_path() / "vecteur-traj";
    }
    std::printf("trajectory tool: %s\n", traj_tool ? traj_tool->c_str() : "(none: /trajectory/simulate not_ready)");
    const selene::App app(kernel_dir && *kernel_dir ? std::optional<std::filesystem::path>(kernel_dir)
                                                    : std::nullopt,
                          dem, dem_reason, slope_dems, traj_tool);

    httplib::Server server;
    server.set_payload_max_length(1 << 20);
    // Handlers run on httplib's worker thread pool; App is immutable except for its mutex-guarded slope cache.
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
