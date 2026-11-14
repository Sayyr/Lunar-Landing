// HTTP-agnostic request routing. main.cpp binds it to cpp-httplib; tests call it directly.
#pragma once

#include <filesystem>
#include <memory>
#include <optional>
#include <string>

#include "ephemeris.hpp"
#include "models.hpp"
#include "slope_cache.hpp"
#include "terrain.hpp"

namespace selene {

constexpr const char* VERSION = "0.1.0";

struct HttpResponse {
    int status;
    json body;
};

class App {
public:
    // dem == nullptr: POST /terrain/slope/check answers status = dem_unavailable with dem_reason.
    explicit App(std::optional<std::filesystem::path> kernel_dir, std::shared_ptr<const Dem> dem = nullptr,
                 std::string dem_reason = "SELENE_DEM_PATH not set")
        : spice_(std::move(kernel_dir)), dem_(std::move(dem)), dem_reason_(std::move(dem_reason)) {}

    // Routes:
    //   GET  /health
    //   POST /evaluate            real ephemerides (SPICE; not ready yet)
    //   POST /evaluate/synthetic  SYNTHETIC demo data for UI development. Never use for analysis.
    //   POST /terrain/slope/check DEM slope check of a circular zone (terrain.hpp)
    HttpResponse handle(const std::string& method, const std::string& path,
                        const std::string& body) const;

    SlopeCache::Stats slope_cache_stats() const { return slope_cache_->stats(); }

private:
    HttpResponse evaluate_with(const EphemerisProvider& provider, const std::string& body) const;
    HttpResponse slope_check_route(const std::string& body) const;

    SpiceEphemerisProvider spice_;
    SyntheticEphemerisProvider synthetic_;
    std::shared_ptr<const Dem> dem_;  // immutable; read_window() is thread-safe
    std::string dem_reason_;
    // Thread-safe (internal mutex); shared_ptr keeps App copyable. See slope_cache.hpp.
    std::shared_ptr<SlopeCache> slope_cache_ = std::make_shared<SlopeCache>(256);
};

}  // namespace selene
